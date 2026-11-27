import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { dataStoreId, loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';

const skill = 'save-zz-board-note', entry = path.resolve('skills', skill, 'scripts/save-note.mjs');
const reader = path.resolve('skills/read-zz-board-project/scripts/read-project.mjs');
const threadId = '00000000-0000-4000-8000-0000000000ab';
const draft = {title:'验收采用中文样例', body:'决定用带图的中文便签。\n- [ ] 核对重开后的段落。'};
const privateText = 'SYNTHETIC_UNRELATED_RESPONSE_TEXT';
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zz-board-save-note-'));
  cleanup.push(() => rm(dir, {recursive:true, force:true}));
  const configDir = path.join(dir,'.codex'), projectDir = path.join(dir,'work'), dataDir = path.join(dir,'board');
  await Promise.all([configDir, projectDir, dataDir].map(p => mkdir(p)));
  const binding = path.join(configDir,'zz-board.json');
  const bind = (url:string, store=dataDir) => writeFile(binding, JSON.stringify({schemaVersion:1, boardUrl:url, dataDir:store}));
  function call(args: string[], script=entry, env: NodeJS.ProcessEnv={}, input=JSON.stringify(draft)) {
    return new Promise<{code:number; stdout:string; stderr:string}>((resolve, reject) => {
      const child = execFile(process.execPath, [script,...args], {cwd:projectDir, windowsHide:true, encoding:'utf8',
        env:{...process.env, HOME:dir, USERPROFILE:dir, CODEX_THREAD_ID:threadId, ...env}}, (error,stdout,stderr) => {
        if (error && typeof error.code !== 'number') reject(error);
        else resolve({code:error ? Number(error.code) : 0, stdout, stderr});
      });
      child.stdin!.on('error', () => { /* a rejected CLI option can close stdin early */ });
      child.stdin!.end(input);
    });
  }
  return {dir,configDir,projectDir,dataDir,binding,bind,call};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Result = Awaited<ReturnType<Fixture['call']>>;
function ok(result:Result) { expect(result.code,result.stderr).toBe(0); return JSON.parse(result.stdout); }
function failed(result:Result, error:string) {
  expect(result.code).not.toBe(0); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain(privateText);
  const failure = JSON.parse(result.stderr); expect(failure.error).toBe(error); return failure;
}
type Post = { mode:string; expectedDataStoreId:string; expectedProjectKey?:string; clientRequestId:string; project: {directory?:string;projectKey?:string};
  source:{hostId:string;threadId:string;threadKey?:string}; title:string; body:string };
type Reply = {data?:unknown; status?:number; location?:string};
async function serve(f:Fixture, handle:(route:string, post?:Post)=>Reply, capable=true) {
  const seen: Array<{route:string; post?:Post; header?:string|string[]}> = [];
  const server = createServer(async (req,res) => {
    const chunks:Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const post:Post|undefined = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const route = req.url!; seen.push({route,post,header:req.headers['x-zz-board-mutation']});
    const reply = route === '/api/health' ? {data:{ok:true,dataStoreId:dataStoreId(f.dataDir),capabilities:{captureConversationNote:capable}}} : handle(route,post);
    res.writeHead(reply.status ?? 200, {'content-type':'application/json', ...(reply.location ? {location:reply.location} : {})});
    res.end(JSON.stringify(reply.data ?? {}));
  });
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  cleanup.push(() => new Promise<void>(resolve=>server.close(()=>resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw Error('expected loopback TCP');
  const url = 'http://127.0.0.1:'+address.port; await f.bind(url); return {url,seen};
}
function receipt(post:Post, projectKey='A') {
  return {status:post.mode === 'preview' ? 'preview' : 'created',noteId:'note:synthetic',projectKey,projectName:'项目',projectNodeId:'bubble',pageId:'page',pageName:'画布',
    source:{projectKey,sourceKind:post.source.hostId === 'local' ? 'codex':'remote', ...post.source, threadKey:post.source.threadKey ?? null}, hidden:privateText};
}

describe('capture a note from the current Codex chat', () => {
  it('previews, saves, retries and reads through the shipped scripts against a synthetic board, retaining attribution only for its own project', async () => {
    const f = await fixture(), db = new BoardDatabase(':memory:'), snapshot = createDemoSnapshot(2);
    const project = snapshot.projects[0]!, otherProject = snapshot.projects[1]!; project.cwd=f.projectDir; project.hostId='local';
    db.importSnapshot(snapshot);
    const app = await buildApp(loadConfig({ZZ_BOARD_DATA_DIR:f.dataDir,ZZ_BOARD_DEMO:'1'}),{db});
    cleanup.push(() => app.close()); await f.bind(await app.listen({port:0,host:'127.0.0.1'}));
    const args = ['--host-id','local'];
    const before = db.getBoard(), history = db.getHistoryStatus();
    const preview = ok(await f.call(args,entry,{CODEX_THREAD_ID:threadId.toUpperCase()}));
    expect(preview).toMatchObject({...draft,status:'preview',projectKey:project.projectKey,source:{hostId:'local',threadId,threadKey:null}});
    expect(db.getBoard()).toEqual(before); expect(db.getHistoryStatus()).toEqual(history);
    const saved = ok(await f.call([...args,'--apply','--preview-token',preview.previewToken]));
    expect(saved).toMatchObject({status:'created',clientRequestId:preview.clientRequestId,noteId:preview.noteId});
    const created = db.getBoard().nodes.find(n=>n.id === saved.noteId)!;
    expect(ok(await f.call(['--latest'],reader)).notes[0]).toMatchObject({id:saved.noteId,
      checklist:[{line:2,completed:false,text:'核对重开后的段落。'}],relation:'direct',noteSource:saved.source});
    db.updateNode(created.id,{revision:created.revision,body:'用户在看板修改的文字'});
    const afterEdit = db.getBoard();
    const replay = ok(await f.call([...args,'--apply']));
    expect(replay).toMatchObject({status:'existing',noteId:created.id}); expect(db.getBoard()).toEqual(afterEdit);
    const note = ok(await f.call(['--note',created.id],reader)).notes[0];
    expect(note).toMatchObject({id:created.id,body:'用户在看板修改的文字',relation:'direct',noteSource:{...saved.source}});
    db.createLink(afterEdit.nodes.find(n=>n.projectKey === otherProject.projectKey && !n.threadKey)!.id,created.id,'共享');
    const shared = ok(await f.call(['--project-key',otherProject.projectKey,'--note',created.id],reader)).notes[0];
    expect(shared.relation).toBe('shared-direct'); expect(shared).not.toHaveProperty('noteSource');
  });

  it('requires the real host and current ID and can relay an explicitly identified remote thread', async () => {
    const f=await fixture(), mock=await serve(f,(_route,post)=>({data:receipt(post!,'R')}));
    failed(await f.call(['--apply']), 'host_required');
    failed(await f.call(['--host-id','local'],entry,{CODEX_THREAD_ID:'',CODEX_SESSION_ID:threadId}), 'thread_required');
    failed(await f.call(['--host-id','local','--thread-id','other']), 'thread_mismatch');
    failed(await f.call(['--host-id','workstation']), 'invalid_project');
    failed(await f.call(['--host-id','workstation','--project-key','R']), 'thread_required'); expect(mock.seen).toHaveLength(0);
    const result = await f.call(['--host-id','workstation','--project-key','R','--thread-id','remote-id','--thread-key','stored:R','--apply']);
    expect(ok(result).source).toMatchObject({projectKey:'R',hostId:'workstation',threadId:'remote-id',threadKey:'stored:R'});
    expect(result.stdout).not.toContain(privateText);
    const writes=mock.seen.filter(req=>req.post);
    expect(writes.map(req=>[req.post!.mode,req.header])).toEqual([['preview','1'],['apply','1']]);
    expect(writes[1]!.post).toMatchObject({expectedDataStoreId:dataStoreId(f.dataDir),expectedProjectKey:'R',title:draft.title,body:draft.body});
  });

  it('retries an originally unindexed note with its later verified key, without changing the preview or its recorded origin', async () => {
    const f = await fixture(), key = 'known:after-sync'; let resolved: string | undefined, status = 'existing';
    const mock = await serve(f, (_route, post) => {
      const data = receipt(post!);
      return { data: { ...data, status: post!.mode === 'apply' ? status : 'preview', source: { ...data.source, threadKey: null }, resolvedThreadKey: resolved } };
    });
    const base = ['--host-id', 'local'];
    const original = ok(await f.call(base));
    const retry = [...base, '--thread-key', key, '--apply', '--preview-token', original.previewToken];
    failed(await f.call(retry), 'invalid_receipt');
    resolved = 'another-key'; failed(await f.call(retry), 'invalid_receipt');
    expect(mock.seen.some(req => req.post?.mode === 'apply')).toBe(false);
    resolved = key;
    expect(ok(await f.call(retry))).toMatchObject({ status, noteId: original.noteId, source: { threadKey: null }, resolvedThreadKey: key });
    status = 'created'; failed(await f.call(retry), 'invalid_receipt');
  });

  it('keeps the draft on this machine when its binding is wrong, the desktop is old or a redirect is returned', async () => {
    const f=await fixture(), args=['--host-id','local','--apply'];
    const sink=await serve(f,()=>({data:{secret:privateText}}));
    const old=await serve(f,()=>({status:500}),false);
    failed(await f.call(args),'unsupported_board'); expect(old.seen.map(r=>r.route)).toEqual(['/api/health']);
    await f.bind(old.url,path.join(f.dir,'different')); failed(await f.call(args),'wrong_board');
    await f.bind('https://board.invalid'); failed(await f.call(args),'invalid_binding');
    const redirect=await serve(f,()=>({status:307,location:sink.url,data:{secret:privateText}}));
    failed(await f.call(args,entry,{HTTP_PROXY:sink.url,HTTPS_PROXY:sink.url,http_proxy:sink.url,https_proxy:sink.url,NO_PROXY:'',no_proxy:'',NODE_USE_ENV_PROXY:'1'}),'board_request_failed');
    expect(redirect.seen.map(r=>r.post?.mode)).toEqual([undefined,'preview']); expect(sink.seen).toHaveLength(0);
  });

  it('binds an accepted preview to its target and content and reports an unverified apply without printing unrelated response fields', async () => {
    const f=await fixture(), args=['--host-id','local']; let target='A', corrupt=false;
    const service=await serve(f,(_route,post)=>{
      const data=receipt(post!,target);
      if(corrupt && post!.mode==='apply') data.source.threadId='different-source';
      return {data};
    });
    const preview=ok(await f.call(args)); target='B';
    failed(await f.call([...args,'--apply','--preview-token',preview.previewToken]),'preview_changed');
    await f.bind(service.url,path.join(f.dir,'different-dataset'));
    const beforeSwitch=service.seen.length;
    failed(await f.call([...args,'--apply','--preview-token',preview.previewToken]),'preview_changed');
    expect(service.seen.length).toBe(beforeSwitch);
    await f.bind(service.url);
    target='A';
    failed(await f.call([...args,'--apply','--preview-token',preview.previewToken],entry,{},JSON.stringify({...draft,body:'另一件事'})),'preview_changed');
    expect(service.seen.some(r=>r.post?.mode==='apply')).toBe(false);
    corrupt=true;
    const failure=failed(await f.call([...args,'--apply']),'invalid_receipt');
    expect(failure.retry).toEqual({clientRequestId:preview.clientRequestId,previewToken:preview.previewToken});
  });

  it('works as a standalone selected install and reads a UTF-8 file from a path with spaces', async () => {
    const f=await fixture(), sync=path.resolve('scripts/sync-skill.mjs'), installArgs=['--skill',skill];
    await serve(f,(_route,post)=>({data:receipt(post!)}));
    const binding=await readFile(f.binding); const preview=await f.call(installArgs,sync); expect(preview.stdout).toContain('Preview only');
    expect(await readdir(f.configDir)).toEqual(['zz-board.json']);
    const install=await f.call([...installArgs,'--apply'],sync); expect(install.code,install.stderr).toBe(0);
    expect(await readFile(f.binding)).toEqual(binding);
    const file=path.join(f.dir,'一张 便签.json'); await writeFile(file,'\uFEFF'+JSON.stringify(draft));
    const installed=path.join(f.configDir,'skills',skill,'scripts/save-note.mjs');
    expect(ok(await f.call(['--host-id','local','--input',file],installed,{},'')).body).toBe(draft.body);
  });
});
