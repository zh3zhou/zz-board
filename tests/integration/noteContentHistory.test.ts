import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { createNoteInputSchema } from '../../src/shared/schema.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { textDocument } from '../../src/shared/noteDocument.js';

let db: BoardDatabase | undefined;
const roots: string[] = [];
const at = (second: number) => new Date(Date.UTC(2026, 0, 2, 0, 0, second));
function now(second: number) { vi.setSystemTime(at(second)); return at(second).toISOString(); }
const create = (body: string) => db!.createNote(createNoteInputSchema.parse({body,x:10,y:10}));
const current = (id: string) => db!.getBoard().nodes.find(n => n.id === id)!;
const patch = (id: string, update: Record<string,unknown>) => db!.updateNode(id, {...update,revision:current(id).revision});
const times = (id: string) => db!.getNoteContentHistory(id).retainedEditTimes;
beforeEach(() => { vi.useFakeTimers({toFake:['Date']}); now(0); });
afterEach(async () => { db?.close(); db = undefined; vi.useRealTimers(); for (const dir of roots.splice(0)) await rm(dir,{recursive:true,force:true}); });

describe('note content save history from retained applied operations', () => {
  it('reports the last real change in a merged session and ignores title, layout, priority and annotation saves', () => {
    db = new BoardDatabase(':memory:'); const n = create('initial'); expect(times(n.id)).toEqual([]);
    now(1); patch(n.id,{body:'one',editSessionId:'typing'});
    const last = now(2); patch(n.id,{body:'two',editSessionId:'typing'});
    now(3); patch(n.id,{title:'title only',editSessionId:'typing'}); patch(n.id,{body:'two',editSessionId:'typing'});
    now(4); patch(n.id,{x:100}); db.setNodePriorities([{id:n.id,revision:current(n.id).revision,manualPriority:'p1'}]); db.createAnnotation(n.id,'comment');
    expect(times(n.id)).toEqual([last]); expect(current(n.id).updatedAt).not.toBe(last); expect(current(n.id).contentEditedAt).toBe(last);
    const other = create('separate'); now(5); patch(other.id,{body:'also separate'});
    const next = now(6); patch(n.id,{body:'newest'});
    expect(db.getNoteContentHistory(n.id)).toEqual({noteId:n.id,boardRevision:db.getBoardRevision(),retainedEditTimes:[next,last]});
  });

  it('ignores text wrapping but records insertion, layout, position and removal of an inline image', () => {
    db = new BoardDatabase(':memory:'); const n = create('ab'), id = 'a'.repeat(64);
    db.registerMedia({id,mime:'image/png',width:4,height:4,bytes:10,previewBytes:4});
    const image = {type:'image',assetId:id,side:'right',width:45};
    const text = (value: string) => ({type:'text',text:value});
    now(1); patch(n.id,{noteDocument:textDocument('ab')}); expect(times(n.id)).toEqual([]); expect(current(n.id).contentEditedAt).toBe(n.createdAt);
    const insert = now(2); patch(n.id,{noteDocument:{version:1,content:[text('ab'),image]}});
    const move = now(3); patch(n.id,{noteDocument:{version:1,content:[text('a'),image,text('b')]}});
    const restyle = now(4); patch(n.id,{noteDocument:{version:1,content:[text('a'),{...image,width:80,side:'left'},text('b')]}});
    const remove = now(5); patch(n.id,{noteDocument:null}); expect(times(n.id)).toEqual([remove,restyle,move,insert]); expect(current(n.id).contentEditedAt).toBe(remove);
  });

  it('records centering as a visual edit even at identical coordinates, with undo and redo preserving the previous wrapping', () => {
    db = new BoardDatabase(':memory:');
    const assetId = 'f'.repeat(64);
    db.registerMedia({id:assetId,mime:'image/png',width:4,height:3,bytes:24,previewBytes:24});
    const note=create('');
    const image={type:'image',assetId,side:'left',width:60,placement:{xPercent:20,offsetY:0}};
    const inserted=now(1); patch(note.id,{noteDocument:{version:1,content:[image]}});
    const centered=now(2); patch(note.id,{noteDocument:{version:1,content:[{...image,wrap:'none'}]}});
    expect(times(note.id)).toEqual([centered,inserted]);
    db.undo(); expect(current(note.id).noteDocument?.content).toEqual([image]); expect(times(note.id)).toEqual([inserted]);
    db.redo(); expect(current(note.id).noteDocument?.content).toEqual([{...image,wrap:'none'}]);
    expect(current(note.id).contentEditedAt).toBe(centered);
  });
  it('tracks only the applied branch across undo, redo, import barriers and permanent deletion', () => {
    db = new BoardDatabase(':memory:'); const n = create('0');
    const one = now(1); patch(n.id,{body:'1'}); const two = now(2); patch(n.id,{body:'2'});
    now(3); db.undo(); expect(times(n.id)).toEqual([one]); expect(current(n.id).contentEditedAt).toBe(one);
    db.redo(); expect(times(n.id)).toEqual([two,one]); expect(current(n.id).contentEditedAt).toBe(two);
    db.undo(); const branch = now(4); patch(n.id,{body:'new branch'});
    db.importSnapshot(createDemoSnapshot(1)); expect(times(n.id)).toEqual([branch,one]);
    const archived = db.setNoteArchived(n.id,true,current(n.id).revision); expect(times(n.id)).toEqual([branch,one]);
    db.deleteNote(n.id,archived.revision); expect(() => db!.getNoteContentHistory(n.id)).toThrow();
  });

  it('recovers only provable old edits, including journal replay, and leaves unproven rows undated', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'zz-board-synthetic-edit-time-')); roots.push(dir);
    const file = path.join(dir, 'test.sqlite'); db = new BoardDatabase(file);
    const proven = create('a'), uncertain = create('b'), onlyCreated = create('c');
    const first = now(1); patch(proven.id, { body: '1' });
    const second = now(2); patch(proven.id, { body: '2', editSessionId: 'dated' });
    now(3); patch(proven.id, {title: 'title', editSessionId: 'dated'});
    now(4); patch(uncertain.id,{body:'merged',editSessionId:'legacy'});
    now(5); patch(uncertain.id,{title:'title',editSessionId:'legacy'});
    now(6); patch(proven.id, {x:300});
    db.close(); db = undefined;
    const old = new DatabaseSync(file);
    try {
      old.exec('ALTER TABLE canvas_nodes DROP COLUMN content_edited_at');
      for (const entry of old.prepare('SELECT sequence, patch_json, edit_session_id FROM operation_journal').all()) {
        const changes = JSON.parse(String(entry.patch_json));
        for (const change of changes) {
          if (change.before) delete change.before.content_edited_at;
          if (change.after) delete change.after.content_edited_at;
          if (entry.edit_session_id === 'legacy') delete change.lastContentEditAt;
        }
        old.prepare('UPDATE operation_journal SET patch_json=? WHERE sequence=?').run(JSON.stringify(changes),entry.sequence!);
      }
    } finally { old.close(); }
    db = new BoardDatabase(file);
    expect(current(proven.id).contentEditedAt).toBe(second);
    expect(current(uncertain.id).contentEditedAt).toBeNull(); expect(current(onlyCreated.id).contentEditedAt).toBeNull();
    db.undo(); db.undo(); db.undo();
    expect(current(proven.id)).toMatchObject({ body: '1', contentEditedAt: first });
    db.redo(); expect(current(proven.id)).toMatchObject({ body: '2', contentEditedAt: second });
  });

  it('preserves verifiable old single saves and omits a legacy merged operation whose last save cannot be dated', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'zz-board-synthetic-note-history-')); roots.push(dir); const file = path.join(dir,'test.sqlite');
    db = new BoardDatabase(file); const n = create('base');
    const old = now(1); patch(n.id,{body:'single'});
    now(2); patch(n.id,{body:'merged',editSessionId:'legacy'}); now(3); patch(n.id,{title:'later title',editSessionId:'legacy'});
    expect(times(n.id)).toEqual([at(2).toISOString(),old]); db.close(); db = undefined;
    const raw = new DatabaseSync(file);
    try { const result = raw.prepare("UPDATE operation_journal SET patch_json=json_remove(patch_json,'$[0].lastContentEditAt') WHERE edit_session_id=?").run('legacy'); expect(result.changes).toBe(1); }
    finally { raw.close(); }
    db = new BoardDatabase(file); expect(times(n.id)).toEqual([old]);
  });
});
