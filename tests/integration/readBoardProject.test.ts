import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { BoardDatabase } from '../../src/server/database.js';
import { dataStoreId, loadConfig } from '../../src/server/config.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { createNoteInputSchema } from '../../src/shared/schema.js';

const skill = 'read-zz-board-project', entry = path.resolve('skills', skill, 'scripts/read-project.mjs');
const sync = path.resolve('scripts/sync-skill.mjs'), exec = promisify(execFile);
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zz-board-project-read-'));
  disposers.push(() => rm(dir, {recursive: true, force: true}));
  const projectDir = path.join(dir, 'work', 'sample'), home = path.join(dir, 'home'), dataDir = path.join(dir, 'store');
  const configDir = path.join(home, '.codex'), bindingFile = path.join(configDir, 'zz-board.json');
  await Promise.all([projectDir, configDir, dataDir].map(p => mkdir(p, {recursive: true})));
  const env = {...process.env, USERPROFILE: home, HOME: home};
  const bind = async (boardUrl: string, store = dataDir) => writeFile(bindingFile, JSON.stringify({schemaVersion: 1, boardUrl, dataDir: store}));
  const call = (args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, script = entry) => exec(process.execPath, [script, ...args], {cwd: projectDir, env: {...env, ...extraEnv}, encoding: 'utf8', windowsHide: true});
  return {dir, home, dataDir, projectDir, configDir, bindingFile, bind, call, view: async (...args: string[]) => JSON.parse((await call(args)).stdout)};
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Reply = {status?: number; body?: unknown; bytes?: Buffer; mime?: string; location?: string};
const when = '2026-01-02T00:00:00.000Z', assetId = 'a'.repeat(64), secret = 'SHOULD_NEVER_REACH_OUTPUT';
async function listen(server: Server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  disposers.push(() => new Promise<void>(resolve => { if (!server.listening) return resolve(); server.close(() => resolve()); }));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('expected loopback TCP');
  return 'http://127.0.0.1:' + addr.port;
}
async function serve(f: Fixture, handler: (route: string) => Reply, history = true) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const route = req.url!; requests.push(req.method + ' ' + route);
    const reply = route === '/api/health' ? {body: {ok: true, dataStoreId: dataStoreId(f.dataDir), ...(history ? {capabilities: {noteContentHistory:true}} : {})}} : handler(route);
    res.writeHead(reply.status ?? 200, {'content-type':reply.mime ?? 'application/json', ...(reply.location ? {location: reply.location} : {})});
    res.end(reply.bytes ?? JSON.stringify(reply.body ?? {}));
  });
  const url = await listen(server); await f.bind(url); return {requests, url, server};
}
const task = (id: string, projectKey: string | null, threadKey: string | null = null) => ({id, kind:'task', projectKey, threadKey, manualPriority:'p3', archivedAt:null, pageId:'one', createdAt:when, updatedAt:when, revision:1, body:secret});
const note = (id: string, body = id, extra = {}) => ({id, kind:'note', title:'title/' + id, body, pageId:'one', manualPriority:null, archivedAt:null, createdAt:when, updatedAt:when, revision:1, ...extra});
const edge = (a: string, b: string) => ({id:a + '/' + b, sourceNodeId:a, targetNodeId:b, label:'link'});
const ann = (id: string, targetNodeId: string, body: string, resolved = false) => ({id, targetNodeId, body, resolved, createdAt:when, updatedAt:when, revision:1});
function board(f: Fixture) {
  return {boardRevision:12, projects:[{projectKey:'A', projectId:'id-a', name:'sample', cwd:f.projectDir, hostId:'local'},
    {projectKey:'B', projectId:'id-b', name:'sample', cwd:path.join(f.dir, 'other', 'sample'), hostId:'local'},
    {projectKey:'R', projectId:'id-r', name:'sample', cwd:f.projectDir, hostId:'remote-host'}],
    pages:[{id:'one',name:'工作页',archivedAt:null},{id:'two',name:'研发页',archivedAt:null},{id:'closed',name:'归档页',archivedAt:when}],
    threads:[{threadKey:'old-A',projectKey:'A',evidence:secret}],
    nodes:[task('project:A','A'),task('legacy',null,'old-A'),{...task('project:B','B'),pageId:'closed'},task('missing-owner',null,'unmapped'),
      note('anchor','规划', {manualPriority:'p1'}),note('picture','',{pageId:'two',noteDocument:{content:[{type:'image',assetId}]}}),note('deep'),note('tail'),
      note('shared'),note('shared-tail',secret),note('foreign',secret),note('orphan',secret),note('mixed',secret),note('unknown',secret),
      note('closed-anchor','archived',{pageId:'closed'}),note('archived-leaf','archived',{archivedAt:when}),note('visible-child'),
      {...task('hidden-root','A','old-A'),pageId:'closed'},note('indirect-visible')],
    links:[edge('anchor','legacy'),edge('anchor','picture'),edge('picture','deep'),edge('deep','tail'),edge('tail','picture'),edge('project:A','shared'),edge('project:B','shared'),
      edge('shared','shared-tail'),edge('foreign','project:B'),edge('mixed','anchor'),edge('mixed','foreign'),edge('missing-owner','unknown'),edge('anchor','unknown'),
      edge('project:A','closed-anchor'),edge('closed-anchor','visible-child'),edge('project:A','archived-leaf'),edge('hidden-root','indirect-visible'),edge('indirect-visible','anchor')],
    annotations:[ann('old-ann','legacy','在旧气泡上的决定'),ann('bubble-ann','project:A','项目批注'),ann('done','picture','已做',true),ann('foreign-ann','foreign',secret),ann('orphan-ann','orphan',secret)],
    todos:[{title:secret}], projectBriefs:[{overview:secret}], settings:{diagnosticPath:secret}, inkStrokes:[{label:secret}]};
}
const rejectRead = async (promise: Promise<unknown>, error: string) => {
  const failure = await promise.then(() => { throw Error('expected reader to fail'); }, e => e);
  expect(failure.stdout).toBe(''); expect(JSON.parse(failure.stderr)).toMatchObject({error}); expect(failure.stderr).not.toContain(secret); return JSON.parse(failure.stderr);
};

describe('read-zz-board-project from a separate project working directory', () => {
  it('selects by saved content within project scope and reads full ordered image occurrences, geometry and local pixels', async () => {
    const f = await fixture(), b = board(f);
    const bytes = await sharp({create:{width:8,height:5,channels:3,background:'blue'}}).png().toBuffer();
    const id = createHash('sha256').update(bytes).digest('hex'), second = 'f'.repeat(64);
    const text = '- [ ] 检查图片\n- [x] 已核对\n', saved = '2026-03-02T10:00:00.000Z', later = '2026-04-01T09:00:00.000Z';
    const layout = {xPercent:18,offsetY:32};
    const content = [{type:'image',assetId:id,side:'right',width:30},{type:'text',text},
      {type:'image',assetId:id,side:'left',width:25,placement:layout},{type:'image',assetId:second,side:'left',width:60,placement:{xPercent:20,offsetY:0},wrap:'none'}];
    const nodes = b.nodes.map(n => ({...n, effectivePriority:null, prioritySource:null, noteSchedule:null,
      contentEditedAt:n.id === 'anchor' ? saved : ['foreign','closed-anchor','orphan'].includes(n.id) ? later : null,
      ...(n.id === 'picture' ? {updatedAt:later, notePresentation:'image', x:-108,y:14,width:200,height:125,
        noteDocument:{version:1,content:[{type:'image',assetId:id,side:'right',width:100}]}} : {}),
      ...(n.id === 'anchor' ? {body:text, x:-26,y:75,width:340,height:182, foldedIntoNodeId:'legacy',noteDocument:{version:1,content}} : {})}));
    let original = bytes;
    const live = await serve(f, route => route === '/api/board' ? {body:{...b, nodes,priorityDate:'2026-03-05'}} :
      route.endsWith('/content-history') ? {body:{noteId:route.split('/')[3],boardRevision:b.boardRevision,retainedEditTimes:[saved]}} :
      route === '/api/media/'+id+'/preview' ? {bytes,mime:'image/png'} :
      route === '/api/media/'+id+'/original' ? {bytes:original,mime:'image/png'} : {status:404});
    const r = await f.view('--latest','--images','preview');
    expect(r.selection).toEqual({by:'latest',noteId:'anchor',timeBasis:'contentEditedAt'});
    expect(r.notes[0]).toMatchObject({id:'anchor',body:text,pageId:'one',notePresentation:'note',canvas:{bounds:{x:-26,y:75,width:340,height:182},unit:'world',folded:true},
      imageAssetIds:[id,second],checklist:[{line:1,completed:false,text:'检查图片'},{line:2,completed:true,text:'已核对'}],
      blocks:[{type:'image',assetId:id,side:'right',widthPercent:30},{type:'text',text},
        {type:'image',assetId:id,side:'left',widthPercent:25,placement:layout},{type:'image',assetId:second,side:'left',widthPercent:60,placement:{xPercent:20,offsetY:0},wrap:'none'}]});
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(r.contentHistory.noteId).toBe('anchor');
    expect(live.requests.filter(route => route.endsWith('/preview'))).toEqual(['GET /api/media/'+id+'/preview','GET /api/media/'+second+'/preview']);
    expect(r.images[1]).toMatchObject({assetId:second,status:'unavailable',reason:'image_missing'});
    async function verifyImage(file: string) {
      expect(path.basename(file)).toBe(id+'.png');
      expect(path.basename(path.dirname(file))).toMatch(/^zz-board-note-/);
      expect(await readFile(file)).toEqual(bytes);
      expect((await sharp(file).metadata()).width).toBe(8);
      disposers.push(() => rm(path.dirname(file),{recursive:true,force:true}));
    }
    await verifyImage(r.images[0].path);
    const picture = await f.view('--note','picture','--images','preview');
    expect(picture.notes[0]).toMatchObject({notePresentation:'image',pageId:'two',
      canvas:{bounds:{x:-108,y:14,width:200,height:125},unit:'world'},blocks:[{type:'image',assetId:id}]});
    await verifyImage(picture.images[0].path);
    const originalRead = await f.view('--note','anchor','--images','original');
    await verifyImage(originalRead.images[0].path);
    original = Buffer.concat([bytes,Buffer.from('wrong')]);
    expect((await f.view('--note','anchor','--images','original')).images[0]).toMatchObject({status:'unavailable',reason:'invalid_image'});
    expect((await f.view('--latest','--include-archived')).selection.noteId).toBe('closed-anchor');
    const requests = live.requests.length;
    await rejectRead(f.call(['--note','foreign','--images','original']), 'note_not_in_scope');
    expect(live.requests.slice(requests)).toEqual(['GET /api/health','GET /api/board']);
    for (const args of [['--images','preview'],['--latest','--note','anchor'],['--note','anchor','--images','other']]) {
      await rejectRead(f.call(args),'invalid_arguments');
    }
  });

  it('uses creation time on legacy boards, supports image-only notes, and stays empty with no matching notes', async () => {
    const f = await fixture(), b = board(f);
    b.nodes.find(n => n.id === 'picture')!.createdAt = '2026-01-06T00:00:00Z';
    await serve(f, () => ({body:b}), false);
    const r = await f.view('--latest');
    expect(r.selection).toEqual({by:'latest',noteId:'picture',timeBasis:'createdAt'});
    expect(r.notes[0]).toMatchObject({body:'',blocks:[{type:'image',assetId,side:'right',widthPercent:45}],canvas:{bounds:null}});
    const empty = await f.view('--latest','--images','preview','--project-key','R');
    expect(empty).toMatchObject({selection:{noteId:null},counts:{notes:0,annotations:0},notes:[],images:[]});
  });
  it('follows visible project and legacy edges across pages and cycles without collecting foreign, ambiguous or unattached content', async () => {
    const f = await fixture(), b = board(f);
    const {requests} = await serve(f, route => route === '/api/board' ? {body:b} : {status:404});
    const {stdout} = await f.call(); const r = JSON.parse(stdout);
    expect(stdout).not.toContain(secret); expect(r.project).toMatchObject({projectKey:'A',matchedBy:'local-directory',bubble:{id:'project:A', manualPriority:'p3'}});
    expect(r.notes.map((n: {id:string}) => n.id)).toEqual(['anchor','deep','indirect-visible','picture','shared','tail']);
    expect(r.notes[0]).toMatchObject({id:'anchor',title:'title/anchor',manualPriority:'p1',relation:'direct',viaNodeId:'legacy',viaLinkId:'anchor/legacy'});
    expect(r.notes).toContainEqual(expect.objectContaining({id:'picture',pageId:'two',body:'',imageAssetIds:[assetId],relation:'indirect',manualPriority:null}));
    expect(r.notes).toContainEqual(expect.objectContaining({id:'indirect-visible',relation:'indirect',viaNodeId:'anchor'}));
    expect(r.notes).toContainEqual(expect.objectContaining({id:'shared',relation:'shared-direct',distance:1}));
    expect(r.annotations.map((a: {id:string}) => a.id)).toEqual(['bubble-ann','old-ann','done']); expect(r.annotations[2].resolved).toBe(true);
    expect(r.pages.map((p: {id:string}) => p.id)).toEqual(['one','two']); expect(requests).toEqual(['GET /api/health','GET /api/board']);
    const withArchived = await f.view('--include-archived');
    for (const id of ['closed-anchor','visible-child','archived-leaf']) expect(withArchived.notes).toContainEqual(expect.objectContaining({id}));
    expect(JSON.stringify(withArchived)).not.toContain(secret);
    await rejectRead(f.call(['--note','foreign']), 'note_not_in_scope');
    expect(requests.some(x => x.includes('/api/notes/') || x.includes('/media/'))).toBe(false);
  });

  it('uses exact roots or explicit keys, distinguishes same names, and reports ambiguity without showing board content', async () => {
    const f = await fixture(), b = board(f); await serve(f, () => ({body:b}));
    expect((await f.view('--project-dir', b.projects[1]!.cwd)).project.projectKey).toBe('B');
    expect((await f.view('--project-key','R')).project).toMatchObject({projectKey:'R',matchedBy:'projectKey',hostId:'remote-host'});
    await rejectRead(f.call(['--project-dir',path.join(f.projectDir,'subdir')]), 'project_not_found');
    await rejectRead(f.call(['--project-key','sample']), 'project_not_found');
    if (process.platform === 'win32') expect((await f.view('--project-dir',path.toNamespacedPath(f.projectDir))).project.projectKey).toBe('A');
    b.projects.push({...b.projects[0]!,projectKey:'A2'});
    expect(await rejectRead(f.call(), 'ambiguous_project')).toMatchObject({candidateProjectKeys:['A','A2']});
    expect((await f.view('--project-key','A')).project.projectKey).toBe('A');
  });

  it('uses the board-evaluated priority, preserves the schedule and pins a calendar day across midnight for pagination', async () => {
    const f = await fixture(), b = board(f); let today = '2026-11-23', wrongDay = false;
    const {requests} = await serve(f, route => {
      const url = new URL(route, 'http://localhost'), date = wrongDay ? today : url.searchParams.get('priorityDate') ?? today;
      return {body:{...b, priorityDate:date, nodes:b.nodes.map(n => {
        const scheduled = n.id === 'tail' || n.id === 'deep';
        const manual = n.manualPriority ? 'p2' : null, dueDate = n.id === 'tail' ? '2026-11-24' : '2026-11-26';
        return {...n, manualPriority:manual, effectivePriority:scheduled ? n.id === 'tail' || date >= '2026-11-24' ? 'p1' : 'p2' : manual,
          prioritySource:scheduled ? 'date' : manual ? 'manual' : null, contentEditedAt:scheduled ? when : null,
          noteSchedule:scheduled ? {dueDate,autoPromote:true,attentionDays:7,priorityDays:2,completed:false,privateField:secret} : null,
          body:n.id === 'tail' ? '长'.repeat(18_000) : n.body};
      })}};
    });
    const page = await f.view();
    expect(page).toMatchObject({priorityDate:'2026-11-23',prioritySupport:'board-evaluated',nextOffset:1});
    expect(page.notes[0]).toMatchObject({id:'tail', manualPriority:null, effectivePriority:'p1', prioritySource:'date', contentEditedAt:when,
      noteSchedule:{dueDate:'2026-11-24',autoPromote:true,attentionDays:7,priorityDays:2,completed:false}});
    expect(JSON.stringify(page)).not.toContain(secret);
    today = '2026-11-24';
    await rejectRead(f.call(['--offset','1','--board-revision','12']), 'priority_date_required');
    const next = await f.view('--offset','1','--board-revision','12','--priority-date',page.priorityDate);
    expect(next.priorityDate).toBe(page.priorityDate); expect(next.notes.map((n:{id:string}) => n.id)).not.toContain('tail');
    expect(requests).toContain('GET /api/board?priorityDate=2026-11-23');
    wrongDay = true;
    await rejectRead(f.call(['--priority-date','2026-11-23']), 'priority_date_unavailable');
    await rejectRead(f.call(['--priority-date','2026-02-30']), 'invalid_arguments');
    await serve(f, () => ({body:b}));
    const old = await f.view(); expect(old).toMatchObject({priorityDate:null, prioritySupport:'manual-only-legacy', project:{bubble:{
      manualPriority:'p3',effectivePriority:'p2',prioritySource:'manual',noteSchedule:null,contentEditedAt:null}}});
    await rejectRead(f.call(['--priority-date','2026-11-23']), 'priority_date_unavailable');
  });

  it('reads only the weekly projection over direct loopback, validates both store identities, and distinguishes empty, unsupported and offline', async () => {
    const f = await fixture(), entry = path.resolve('skills/review-zz-board-week/scripts/read-week.mjs'), requests:string[] = [];
    const store = dataStoreId(f.dataDir);
    let supports = true, correct = true, healthStore = store, redirect = false, malformed = false, rawRef = '';
    let receivedAtProxy = 0;
    const sink = await listen(createServer((_req,res) => { receivedAtProxy++; res.end(secret); }));
    const server = createServer((req,res) => {
      requests.push(req.method + ' ' + req.url);
      if (req.url === '/api/health') { res.end(JSON.stringify({ok:true, dataStoreId:healthStore, capabilities:{weeklyReview:supports}})); return; }
      if (redirect) { res.writeHead(302,{location:sink}); res.end(secret); return; }
      const current = req.url?.endsWith('current');
      res.end(JSON.stringify({schemaVersion:1, dataStoreId:correct ? store : 'wrong', privateField:secret,
        period:{week:current ? 'current':'previous', startDate:'2026-11-16', endDate:'2026-11-22',
          through:'2026-11-22T15:59:59.999Z', timeZone:'Asia/Shanghai'},
        coverage:{registeredProjects:malformed ? 2 : 1, activeProjects:0, withoutDatedActivityThisWeek:1, demoProjectsExcluded:0, undatedMilestones:0},
        activeProjects:[],earlierProjects:rawRef ? [{projectKey:rawRef === 'project' ? 'cwd:S:/' + secret : 'safe',
          name:'合成项目',archived:false,lastRecorded:{kind:'conversation',id:rawRef === 'record' ? 'thread:folder%2F' + secret : 'safe',occurredAt:'2026-11-10'}}] : []}));
    });
    await f.bind(await listen(server));
    const call = (args:string[] = []) => f.call(args,{HTTP_PROXY:sink, http_proxy:sink, NO_PROXY:'',no_proxy:'',NODE_USE_ENV_PROXY:'1'},entry);
    const first = await call(); expect(first.stdout).not.toContain(secret);
    expect(JSON.parse(first.stdout)).toMatchObject({period:{week:'previous'},coverage:{registeredProjects:1,activeProjects:0}});
    expect(JSON.parse((await call(['--week','current'])).stdout).period.week).toBe('current');
    expect(requests).toEqual(['GET /api/health','GET /api/reviews/weekly?week=previous','GET /api/health','GET /api/reviews/weekly?week=current']);
    await rejectRead(call(['--week','last']), 'invalid_arguments');
    malformed = true; await rejectRead(call(), 'invalid_response'); malformed = false;
    rawRef = 'project'; await rejectRead(call(), 'invalid_response'); rawRef = 'record'; await rejectRead(call(), 'invalid_response'); rawRef = '';
    correct = false; await rejectRead(call(), 'wrong_board'); correct = true;
    redirect = true; await rejectRead(call(), 'board_request_failed'); expect(receivedAtProxy).toBe(0);
    supports = false; await rejectRead(call(), 'unsupported_board'); expect(requests.at(-1)).toBe('GET /api/health');
    healthStore = 'other'; await rejectRead(call(), 'wrong_board'); expect(requests.at(-1)).toBe('GET /api/health');
    await new Promise<void>(resolve => server.close(() => resolve())); await rejectRead(call(), 'board_unavailable');
    await f.bind('https://board.invalid'); await rejectRead(call(), 'invalid_binding');
  });

  it('pages whole large records and refuses to join different board revisions', async () => {
    const f = await fixture(), b = board(f), longBody = '长'.repeat(19_995)+'结尾';
    b.nodes.push(note('long',longBody,{manualPriority:'p1'})); b.links.push(edge('project:A','long'));
    await serve(f, r => r === '/api/board' ? {body:b} : {body:{noteId:'long',boardRevision:999,retainedEditTimes:[]}});
    const first = await f.view(); expect(first.nextOffset).toBe(1); const second = await f.view('--offset','1','--board-revision','12');
    expect(second.notes[0].body).toBe(longBody); expect(second.notes).toHaveLength(1);
    const tail = await f.view('--offset',String(second.nextOffset),'--board-revision','12'); expect(tail.nextOffset).toBeNull();
    expect(first.notes.length+second.notes.length+tail.notes.length).toBe(first.counts.notes);
    await rejectRead(f.call(['--note','long']), 'board_changed'); b.boardRevision++;
    await rejectRead(f.call(['--offset','1','--board-revision','12']), 'board_changed');
    await rejectRead(f.call(['--offset','1']), 'invalid_arguments');
  });

  it('lets an archived main bubble close all visible aliases, while supporting pre-page boards with only a legacy thread', async () => {
    const f = await fixture(), b = board(f); let response: unknown = b;
    await serve(f, () => ({body:response}));
    b.nodes.find(n => n.id === 'project:A')!.pageId = 'closed';
    const closed = await f.view(); expect(closed.project).toMatchObject({bubble:null,excludedByArchive:true}); expect(closed.counts).toEqual({notes:0, annotations:0});
    await rejectRead(f.call(['--note','anchor']), 'note_not_in_scope');
    expect((await f.view('--include-archived')).notes.map((n:{id:string}) => n.id)).toContain('anchor');
    response = {boardRevision:3, projects:b.projects, threads:b.threads, annotations:[ann('old-ann','legacy','旧批注')],
      nodes:[task('legacy',null,'old-A'),note('old-note','旧内容')].map(({pageId: _page, ...n}) => n), links:[edge('legacy','old-note')]};
    const legacy = await f.view(); expect(legacy.project.bubble).toBeNull();
    expect(legacy.notes[0]).toMatchObject({body:'旧内容',pageId:'page:default',relation:'direct'});
    expect(legacy.annotations[0].id).toBe('old-ann'); expect(legacy.pages[0].name).toBe('默认页');
  });

  it('distinguishes an older desktop from a note deleted between the board and history reads', async () => {
    const f = await fixture(), b = board(f); const reply = (r: string) => r === '/api/board' ? {body:b} : {status:404,body:{message:secret}};
    const old = await serve(f, reply, false); const legacy = await f.view('--note','anchor');
    expect(legacy.contentHistory).toEqual({status:'unavailable'}); expect(legacy.notes[0].body).toBe('规划');
    expect(old.requests).toEqual(['GET /api/health','GET /api/board']);
    const current = await serve(f, reply); await rejectRead(f.call(['--note','anchor','--board-revision','12']), 'board_changed');
    expect(current.requests).toEqual(['GET /api/health','GET /api/board','GET /api/notes/anchor/content-history']);
  });

  it('verifies the binding before loading notes, never follows redirects or proxies, and reports an offline board separately', async () => {
    const f = await fixture(), b = board(f); let externalRequests = 0, redirect = true;
    const sink = await listen(createServer((_req, res) => { externalRequests++; res.end(secret); }));
    const live = await serve(f, () => redirect ? {status:302, location:sink, body:secret} : {body:b});
    await f.bind(live.url, path.join(f.dir,'wrong-store')); await rejectRead(f.call(), 'wrong_board');
    expect(live.requests).toEqual(['GET /api/health']);
    await f.bind('https://board.invalid'); await rejectRead(f.call(), 'invalid_binding');
    await f.bind(live.url); await rejectRead(f.call(), 'board_request_failed'); redirect = false;
    const result = await f.call([], {HTTP_PROXY:sink,HTTPS_PROXY:sink,NO_PROXY:'',http_proxy:sink,https_proxy:sink,no_proxy:'',NODE_USE_ENV_PROXY:'1'});
    expect(JSON.parse(result.stdout).counts.notes).toBeGreaterThan(0); expect(externalRequests).toBe(0);
    await new Promise<void>(resolve => live.server.close(() => resolve())); await rejectRead(f.call(), 'board_unavailable');
    await rm(f.bindingFile); await rejectRead(f.call(), 'binding_unavailable');
  });

  it('reads a real synthetic service by cwd, returns independent priorities and history, and leaves the entire board and journal unchanged', async () => {
    const f = await fixture(), db = new BoardDatabase(':memory:'); const snapshot = createDemoSnapshot(2);
    const p = snapshot.projects[0]!; p.hostId = 'local'; p.cwd = f.projectDir;
    db.importSnapshot(snapshot);
    const bubble = db.getBoard().nodes.find(n => n.projectKey === p.projectKey)!;
    const n = db.createNote(createNoteInputSchema.parse({body:'草稿',x:3,y:6}));
    const edited = db.updateNode(n.id,{revision:n.revision,body:'已记录的问题'});
    db.setNodePriorities([{id:bubble.id,revision:bubble.revision,manualPriority:'p2'},{id:n.id,revision:edited.revision,manualPriority:'p1'}]);
    const link = db.createLink(bubble.id,n.id,'讨论'), comment = db.createAnnotation(n.id,'待确认');
    const app = await buildApp(loadConfig({ZZ_BOARD_DATA_DIR:f.dataDir, ZZ_BOARD_DEMO:'1'}),{db});
    disposers.push(() => app.close()); const http = await app.listen({port:0,host:'127.0.0.1'}); await f.bind(http);
    const before = db.getBoard(), history = db.getHistoryStatus();
    const overview = await f.view(); expect(overview.project).toMatchObject({projectKey:p.projectKey,bubble:{manualPriority:'p2'}});
    const detail = await f.view('--note',n.id); expect(detail.notes).toHaveLength(1);
    expect(detail.notes[0]).toMatchObject({id:n.id,body:'已记录的问题',viaLinkId:link.id,manualPriority:'p1',createdAt:n.createdAt});
    expect(detail.annotations).toEqual([expect.objectContaining({id:comment.id,body:'待确认',targetNodeId:n.id})]);
    expect(detail.contentHistory).toEqual({status:'retained-applied-only',noteId:n.id,complete:false,retainedEditTimes:[edited.updatedAt]});
    for (const id of ['missing',bubble.id]) expect((await app.inject({method:'GET',url:'/api/notes/'+encodeURIComponent(id)+'/content-history'})).statusCode).toBe(404);
    expect(db.getBoard()).toEqual(before); expect(db.getHistoryStatus()).toEqual(history);
  });

  it('reads this week from an actual synthetic desktop service with identity, event stage, date and coverage intact', async () => {
    const f = await fixture(), db = new BoardDatabase(':memory:'), weekEntry = path.resolve('skills/review-zz-board-week/scripts/read-week.mjs');
    const snapshot = createDemoSnapshot(0), p = snapshot.projects[0]!;
    p.hostId = 'local'; p.cwd = f.projectDir; db.importSnapshot(snapshot);
    const date = new Date().toISOString();
    db.timeline.record({projectKey:p.projectKey,sourceKey:'synthetic-record',sourceLabel:secret,sourceKind:'file',threadKey:null,
      sourceUpdatedAt:date,checkedAt:date,summarizedAt:date},
      [{id:'build',kind:'version',title:'合成版本已构建',occurredAt:date,problem:null,options:[],decision:null,result:'构建已核实',
        resolution:'verified',sourceRefs:['a'],version:{product:'合成程序',number:'1.0',stage:'built'}}],
      [{id:'a',role:'file',occurredAt:date,turnId:null,path:secret}]);
    const app = await buildApp(loadConfig({ZZ_BOARD_DATA_DIR:f.dataDir,ZZ_BOARD_DEMO:'1'}),{db});
    disposers.push(() => app.close()); await f.bind(await app.listen({port:0,host:'127.0.0.1'}));
    const before = db.timeline.page(p.projectKey), history = db.getHistoryStatus();
    const {stdout} = await f.call(['--week','current'],{},weekEntry);
    expect(stdout).not.toContain(secret); expect(JSON.parse(stdout)).toMatchObject({coverage:{registeredProjects:1,activeProjects:1,demoProjectsExcluded:7},
      activeProjects:[{projectKey:p.projectKey,milestones:[{kind:'version',id:before.items[0].key,occurredAt:date,version:{stage:'built'}}]}]});
    expect(db.timeline.page(p.projectKey)).toEqual(before); expect(db.getHistoryStatus()).toEqual(history);
  });

  it('previews and installs just the selected Skill into a synthetic home without touching the binding or sibling Skills', async () => {
    const f = await fixture(), skillRoot = path.join(f.configDir,'skills'); const sibling = path.join(skillRoot,'review-project-progress');
    await mkdir(sibling,{recursive:true}); await writeFile(path.join(sibling,'SKILL.md'),'keep unrelated bytes'); await f.bind('http://127.0.0.1:1');
    const originalBinding = await readFile(f.bindingFile), args = ['--skill',skill];
    expect((await f.call(args,{},sync)).stdout).toContain('Preview only'); expect(await readdir(skillRoot)).toEqual(['review-project-progress']);
    const applied = await f.call([...args,'--apply'],{},sync); expect(applied.stdout).toContain('Installed 5 canonical files');
    expect((await f.call(args,{},sync)).stdout).toContain('already current'); expect(await readFile(f.bindingFile)).toEqual(originalBinding);
    expect(await readFile(path.join(sibling,'SKILL.md'),'utf8')).toBe('keep unrelated bytes');
    const installed = path.join(skillRoot,skill,'scripts','read-project.mjs'); await serve(f,()=>({body:board(f)}));
    expect(JSON.parse((await f.call([],{},installed)).stdout).project.projectKey).toBe('A');
  });
});
