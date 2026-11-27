import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { createNoteInputSchema } from '../../src/shared/schema.js';
import { documentText, type NoteContent } from '../../src/shared/noteDocument.js';
import { ProjectNotes, setChecklistItem } from '../../src/web/ProjectNotes.js';

describe('editable checklist in the saved note', () => {
  it('shows two linked original notes in the overview and keeps the full project list accessible', () => {
    const db = new BoardDatabase(':memory:');
    try {
      const snapshot = createDemoSnapshot(0), projectKey = snapshot.projects[0]!.projectKey;
      db.importSnapshot(snapshot);
      const project = db.getBoard().nodes.find(node => node.projectKey === projectKey)!;
      const render = (compact: boolean) => renderToStaticMarkup(createElement(ProjectNotes, {
        board: db.getBoard(), projectKey, priorityDate: '2026-11-26', onLocate() {},
        onShowAll: compact ? () => {} : undefined
      }));
      expect(render(true)).toBe('');
      for (const label of ['A','B','C']) {
        const note = db.createNote(createNoteInputSchema.parse({title:'纸样 ' + label,body:'每张都要留裁切线。\n背面写纸张编号。\n第三行回到原卡阅读。',x:0,y:0}));
        db.createLink(project.id, note.id, '');
      }
      db.createNote(createNoteInputSchema.parse({title:'未关联纸样',body:'与此项目无关',x:0,y:0}));
      const preview = render(true), all = render(false);
      expect(preview.match(/每张都要留裁切线。/g)).toHaveLength(2);
      expect(preview).toContain('查看全部 3 张便签');
      expect(preview).toContain('背面写纸张编号。');
      expect(preview).not.toMatch(/第三行|未关联纸样|来自对话的便签/);
      expect(preview).not.toMatch(/直接关联|\d{2}:\d{2}:\d{2}/);
      expect(all).toContain('直接关联');
      expect(all.match(/class="project-note-title"/g)).toHaveLength(3);
      expect(all).not.toContain('未关联纸样');
    } finally { db.close(); }
  });
  it('re-evaluates a connected note on the current canvas date when the cached board is from yesterday', () => {
    const db = new BoardDatabase(':memory:');
    try {
      const snapshot = createDemoSnapshot(0), projectKey = snapshot.projects[0]!.projectKey;
      db.importSnapshot(snapshot);
      const project = db.getBoard().nodes.find(node => node.projectKey === projectKey)!;
      const note = db.createNote(createNoteInputSchema.parse({body:'跨天的便签',x:0,y:0}));
      db.setNodePriorities([{id:note.id,revision:note.revision,manualPriority:null,noteSchedule:{dueDate:'2026-11-27',autoPromote:true,attentionDays:7,priorityDays:1,completed:false}}]);
      db.createLink(project.id,note.id,'已连接');
      const board = db.getBoard('2026-11-25');
      expect(board.nodes.find(node => node.id === note.id)!.effectivePriority).toBe('p2');
      const html = renderToStaticMarkup(createElement(ProjectNotes,{board,projectKey,priorityDate:'2026-11-26',onLocate:() => {}}));
      expect(html).toContain('优先'); expect(html).not.toContain('关注');
    } finally { db.close(); }
  });
  it('toggles the requested marker across rich blocks without moving an image or changing code samples', () => {
    const image = {type:'image',assetId:'a'.repeat(64),side:'left',width:24} as const;
    const note: NoteContent = {body:'~~~\r\n- [ ] 示例\r\n~~~\r\n- [ ] 核对',noteDocument:{version:1,content:[
      {type:'text',text:'~~~\r\n- [ ] 示例\r\n~~~\r\n- ['},image,{type:'text',text:' ] 核对'}]}};
    expect(setChecklistItem(note,2,true)).toBeNull();
    const done = setChecklistItem(note,4,true)!;
    expect(done.body).toBe('~~~\r\n- [ ] 示例\r\n~~~\r\n- [x] 核对');
    expect(done.noteDocument!.content[1]).toBe(image);
    expect(documentText(done.noteDocument!)).toBe(done.body);
    expect(setChecklistItem(done,4,true)).toBeNull();
    expect(setChecklistItem(done,4,false)).toEqual(note);
    expect(setChecklistItem({body:'- [ ] 纯文本'},1,true)).toEqual({body:'- [x] 纯文本',noteDocument:null});
  });
});
