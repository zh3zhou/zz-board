import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { dataStoreId, loadConfig } from '../../src/server/config.js';
import { BoardDatabase } from '../../src/server/database.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import type { Milestone } from '../../src/shared/milestones.js';

const now = new Date(2026,10,24,12), observed = new Date(2026,10,19,12).toISOString();
const secret = 'SECRET_RAW_TEXT_OR_PRIVATE_PATH';
const opened:BoardDatabase[] = [];
const directories:string[] = [];
function scratchDatabase() {
  const dir = mkdtempSync(path.join(os.tmpdir(),'zz-weekly-legacy-')); directories.push(dir);
  return path.join(dir,'synthetic.sqlite');
}
afterEach(() => {
  opened.splice(0).forEach(db => db.close()); directories.splice(0).forEach(dir => rmSync(dir,{recursive:true,force:true})); vi.useRealTimers();
});
function seed(keys:string[], threads: Array<{id:string; projectKey:string; date?:string; demo?:boolean}> = [], file = ':memory:') {
  const db = new BoardDatabase(file); opened.push(db);
  const snapshot = createDemoSnapshot(1, new Date(observed));
  const example = snapshot.threads[0]!;
  snapshot.source = 'review-project-progress'; snapshot.projectBriefs = []; snapshot.todos = [];
  snapshot.projects = keys.map((key,index) => ({projectKey:key, name:key.startsWith('same') ? '同名项目' : key, hostId:key === 'demo' ? 'demo' : 'local',
    cwd:secret, observedAt:observed, sidebarIndex:index}));
  snapshot.threads = threads.map((t,index):typeof example => ({...example, sourceKind:t.demo ? 'demo' : 'codex', threadKey:t.id,threadId:t.id,
    projectKey:t.projectKey, hostId:t.demo ? 'demo':'local', sourceUpdatedAt:t.date, sidebarIndex:index, title:secret, displayTitle:secret, stopPoint:secret, evidence:secret}));
  db.importSnapshot(snapshot); return db;
}
function milestone(db:BoardDatabase, projectKey:string, id:string, occurredAt:string | null, patch:Partial<Milestone> = {}, fileKey = 'file-' + id) {
  const ref = 'ref-' + id;
  db.timeline.record({projectKey,sourceKey:fileKey,sourceLabel:secret,sourceKind:'file',threadKey:null,
    sourceUpdatedAt:observed,checkedAt:observed,summarizedAt:observed},
    [{id,kind:'achievement',title:id, occurredAt, problem:null,options:[],decision:null,result:'通过合成验证',
      resolution:'verified',version:null,sourceRefs:[ref],...patch}],
    [{id:ref,role:'file',occurredAt:observed,turnId:null,path:secret}]);
}
function archiveProject(db:BoardDatabase, key:string) {
  const page = db.createPage('归档页'), node = db.getBoard().nodes.find(n => n.projectKey === key)!;
  db.applySelectionAction({action:'movePage',targetPageId:page.id,nodes:[{id:node.id,revision:node.revision}],ink:[]});
  db.archivePage(page.id,{archived:true,revision:db.getPage(page.id).revision});
}

describe('saved, local-calendar weekly project review', () => {
  it('aliases embedded legacy directories in project, thread, note and event keys in both active and earlier results', () => {
    const winKey = 'cwd:T:\\' + secret + '\\same', unixKey = 'cwd:/fixture/' + secret + '/same';
    const encodedThread = 'legacy:' + encodeURIComponent('/' + secret + '/thread'), oldThread = 'remote:' + unixKey + ':old';
    const file = scratchDatabase(), db = seed([winKey,unixKey,'plain-project'],[
      {id:encodedThread,projectKey:winKey,date:'2026-11-17'}, {id:oldThread,projectKey:unixKey,date:'2026-11-12'},
      {id:'codex:local:ordinary',projectKey:'plain-project',date:'2026-11-17'}
    ], file);
    milestone(db,winKey,'合成事实','2026-11-22');
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(2026,10,19,12));
    const note = db.createNote({title:'',body:'合成笔记',x:0,y:0,width:180,height:120});
    const noteId = 'note:imported:' + unixKey, eventId = 'event:file:T:\\' + secret + '\\record';
    const old = new DatabaseSync(file);
    try {
      old.prepare('UPDATE projects SET name=? WHERE project_key=?').run('UI/UX','plain-project');
      old.prepare('UPDATE canvas_nodes SET id=? WHERE id=?').run(noteId,note.id);
      old.prepare('UPDATE project_milestones SET event_key=? WHERE project_key=?').run(eventId,winKey);
    } finally { old.close(); }
    db.createLink('project:' + winKey,noteId,'关联');
    const week = db.getWeeklyReview('previous',now), active = week.activeProjects.find(p => p.name === 'same')!;
    expect(active.projectKey).toMatch(/^zzb-week:project:[a-f0-9]{32}$/);
    expect(week.earlierProjects[0]).toMatchObject({name:'same',projectKey:expect.stringMatching(/^zzb-week:project:/),
      lastRecorded:{id:expect.stringMatching(/^zzb-week:thread:/)}});
    expect(week.earlierProjects[0].projectKey).not.toBe(active.projectKey);
    expect(active.activities).toMatchObject([{kind:'noteCreated',id:expect.stringMatching(/^zzb-week:note:/)},
      {kind:'conversation',id:expect.stringMatching(/^zzb-week:thread:/)}]);
    expect(active.milestones[0].id).toMatch(/^zzb-week:event:/);
    expect(week.activeProjects.find(p => p.projectKey === 'plain-project')).toMatchObject({name:'UI/UX',activities:[{id:'codex:local:ordinary'}]});
    const later = db.getWeeklyReview('previous',new Date(2026,11,1));
    expect(later.earlierProjects[0]).toMatchObject({projectKey:active.projectKey,lastRecorded:{id:active.milestones[0].id}});
    expect(JSON.stringify([week,later])).not.toContain(secret);
  });

  it('keeps a deleted demonstration thread’s orphaned milestones out of a mixed project after ordinary desktop cleanup', () => {
    const file = scratchDatabase(), db = seed(['mixed'],[{id:'real',projectKey:'mixed'},{id:'demo-chat',projectKey:'mixed',demo:true}],file);
    for (const id of ['real','demo-chat']) {
      db.timeline.record({projectKey:'mixed',sourceKey:id,sourceLabel:id,sourceKind:'thread',threadKey:id,sourceUpdatedAt:observed,
        checkedAt:observed,summarizedAt:observed},[{id,kind:'discussion',title:id,occurredAt:'2026-11-16',problem:'讨论',options:[],
        decision:null,result:null,resolution:'open',sourceRefs:['s'],version:null}],
        [{id:'s',role:'user',occurredAt:observed,turnId:null,path:null}]);
    }
    milestone(db,'mixed','真实文件记录','2026-11-18');
    const expected = db.getWeeklyReview('previous',now);
    expect(expected.activeProjects[0].milestones.map(m => m.title)).toEqual(['真实文件记录','real']);
    db.close(); opened.splice(opened.indexOf(db),1);
    const cleaned = new BoardDatabase(file,{cleanupDemoData:true}); opened.push(cleaned);
    expect(cleaned.startupDemoCleanup.threadsRemoved).toBe(1);
    expect(cleaned.timeline.page('mixed').items.some(m => m.sourceKey === 'demo-chat')).toBe(true);
    expect(cleaned.getWeeklyReview('previous',now)).toEqual(expected);
  });

  it('covers all registered projects using event dates, retaining version stages and resolutions with no synthetic or private spillover', () => {
    const db = seed(['ZZ Board','same-A','same-B','old','archived-older','unknown','demo'], [
      {projectKey:'same-A',id:'conversation-only',date:'2026-11-19'}, {projectKey:'unknown',id:'checked-only'},
      {projectKey:'demo',id:'fake',date:'2026-11-18',demo:true}]);
    milestone(db,'ZZ Board','周一的决定','2026-11-16',{kind:'decision',resolution:'decided',decision:'使用本地数据',result:null});
    const version = {product:'示例',number:'1.0',stage:'built' as const};
    milestone(db,'ZZ Board','构建记录','2026-11-22',{kind:'version',resolution:'delivered',version});
    milestone(db,'ZZ Board','另一处构建记录','2026-11-22',{kind:'version',resolution:'delivered',version});
    milestone(db,'ZZ Board','未核验上线','2026-11-22',{kind:'discussion',resolution:'open',result:null,problem:'是否上线'});
    milestone(db,'ZZ Board','源码阶段','2026-11-16',{kind:'version',resolution:'delivered',version:{...version,stage:'source'}});
    milestone(db,'same-B','已撤回的决定','2026-11-22',{kind:'decision',resolution:'withdrawn',decision:'曾选择方案甲',result:null});
    milestone(db,'old','旧事实','2026-11-13');
    milestone(db,'archived-older','旧归档','2026-11-12'); archiveProject(db,'archived-older');
    milestone(db,'unknown','没有日期',null);
    milestone(db,'unknown','未来的事实','2026-11-23');
    milestone(db,'demo','示范成果','2026-11-18');
    archiveProject(db,'same-B');
    const before = {history:db.getHistoryStatus(),board:db.getBoard(),timeline:db.timeline.page('ZZ Board')};
    const r = db.getWeeklyReview('previous', now);
    expect(r).toMatchObject({period:{week:'previous',startDate:'2026-11-16',endDate:'2026-11-22'},
      coverage:{registeredProjects:6,activeProjects:3,withoutDatedActivityThisWeek:3,demoProjectsExcluded:1,undatedMilestones:1}});
    const board = r.activeProjects.find(p => p.projectKey === 'ZZ Board')!;
    expect(board.counts.milestones).toBe(4); expect(board.milestones.map(m => m.version?.stage).filter(Boolean).sort()).toEqual(['built','source']);
    expect(board.milestones).toContainEqual(expect.objectContaining({title:'未核验上线',resolution:'open',detail:'是否上线'}));
    expect(r.activeProjects.find(p => p.projectKey === 'same-B')).toMatchObject({name:'同名项目',archived:true,milestones:[{resolution:'withdrawn'}]});
    expect(r.activeProjects.find(p => p.projectKey === 'same-A')).toMatchObject({name:'同名项目',counts:{milestones:0,conversations:1}});
    expect(r.earlierProjects.map(p => p.projectKey)).toEqual(['old']); expect(r.earlierProjects[0].lastRecorded).toMatchObject({title:'旧事实',occurredAt:'2026-11-13'});
    expect(JSON.stringify(r)).not.toContain(secret);
    expect({history:db.getHistoryStatus(),board:db.getBoard(),timeline:db.timeline.page('ZZ Board')}).toEqual(before);
  });

  it('honors local midnight, Sunday, future hours and old conversation turns even when the latest source update is later', () => {
    const db = seed(['A','B','C'], [{id:'chat',projectKey:'B',date:'2026-11-24'}]);
    const start = new Date(2026,10,16), end = new Date(2026,10,23);
    // Render real instants at +14:00 to exercise offsets independent of the test host's timezone.
    const stamp = (time:number) => new Date(time + 14*3600000).toISOString().replace('Z','+14:00');
    milestone(db,'A','just-before',stamp(start.getTime()-1)); milestone(db,'A','first',stamp(start.getTime()));
    milestone(db,'A','last',stamp(end.getTime()-1)); milestone(db,'A','next',stamp(end.getTime()));
    milestone(db,'C','today-future',stamp(now.getTime()+1000)); milestone(db,'C','today', '2026-11-24');
    db.conversations.updateColumn('B',{threadKey:'chat',title:secret,sourceUpdatedAt:'2026-11-24',hasEarlier:false,nextCursor:null,coverage:[],checkedAt:observed});
    const turns = db.conversations.prepare('chat',[{turnId:'old-turn',occurredAt:'2026-11-17',fingerprint:'fp',ordinal:0,previousTurnId:null,evidence:[],gaps:[]}],false);
    db.conversations.commit({conversationKey:'c',projectKey:'B',threadKey:'chat',title:secret,sourceUpdatedAt:'2026-11-24',checkedAt:observed,fingerprint:'fp',turns,context:[]},
      [{turnId:'old-turn',title:secret,summary:secret,sourceRefs:['a'],reference:null,continuesPrevious:false}]);
    const week = db.getWeeklyReview('previous', now); expect(week.activeProjects[0].milestones.map(f => f.title)).toEqual(['last','first']);
    expect(week.activeProjects.find(p => p.projectKey === 'B')).toMatchObject({counts:{conversations:1},activities:[{occurredAt:'2026-11-17'}]});
    const current = db.getWeeklyReview('current', now);
    expect(current.period).toMatchObject({startDate:'2026-11-23',endDate:'2026-11-29',through:now.toISOString()});
    expect(current.activeProjects.find(p => p.projectKey === 'C')?.milestones.map(m => m.title)).toEqual(['today']);
    const monday = db.getWeeklyReview('current',end);
    expect(monday.activeProjects.flatMap(p => p.milestones).map(m => m.title)).toEqual(['next']); expect(JSON.stringify(week)).not.toContain(secret);
  });

  it('counts the creation and last content save of uniquely linked notes without surfacing the text or counting layout changes', () => {
    const db = seed(['A','B']);
    const bubbles = db.getBoard().nodes.filter(n => n.kind === 'task');
    vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(new Date(2026,10,10,14));
    const make = () => db.createNote({title:secret,body:secret,x:1,y:1,width:180,height:120});
    const old = make(); db.createLink(bubbles[0].id,old.id,'');
    vi.setSystemTime(new Date(2026,10,17,14));
    const mine = make(), shared = make(); make();
    db.createLink(mine.id,bubbles[0].id,''); db.createLink(bubbles[0].id,shared.id,''); db.createLink(bubbles[1].id,shared.id,'');
    db.updateNode(old.id,{revision:old.revision,x:33});
    vi.setSystemTime(new Date(2026,10,18,14));
    db.updateNode(mine.id,{revision:mine.revision,body:'新的合成笔记正文'});
    const r = db.getWeeklyReview('previous',now);
    expect(r.activeProjects).toHaveLength(1); expect(r.activeProjects[0]).toMatchObject({projectKey:bubbles[0].projectKey,
      counts:{milestones:0, conversations:0, notesCreated:1,notesEdited:1},activities:[{id:mine.id,kind:'noteEdited'},{id:mine.id,kind:'noteCreated'}]});
    expect(JSON.stringify(r)).not.toMatch(/SECRET_RAW|新的合成/);
  });

  it('keeps the local Sunday evening in a DST transition week and limits examples per project while covering every project', () => {
    const db = seed(['many','also-active','old-1','old-2','old-3']);
    for (let i = 1; i <= 6; i++) milestone(db,'many','成果-' + i,new Date(2026,10,1,23,i).toISOString());
    milestone(db,'also-active','另一项','2026-10-26');
    milestone(db,'old-1','最早','2026-10-16'); milestone(db,'old-2','较晚','2026-10-17'); milestone(db,'old-3','最近','2026-10-18');
    milestone(db,'old-1','下周',new Date(2026,10,2,0,0).toISOString());
    const r = db.getWeeklyReview('previous',new Date(2026,10,2,9));
    expect(r.period).toMatchObject({startDate:'2026-10-26',endDate:'2026-11-01',through:new Date(new Date(2026,10,2).getTime()-1).toISOString()});
    expect(r.coverage).toMatchObject({registeredProjects:5,activeProjects:2,withoutDatedActivityThisWeek:3});
    expect(r.activeProjects.map(p => [p.projectKey,p.counts.milestones,p.milestones.length])).toEqual([['many',6,4],['also-active',1,1]]);
    expect(r.earlierProjects.map(p => p.projectKey)).toEqual(['old-3','old-2']);
  });

  it('serves a store-bound default week from a read-only GET without requesting Codex access or refreshing summaries', async () => {
    const db = seed(['A']); const dir = mkdtempSync(path.join(os.tmpdir(),'zz-weekly-api-'));
    const model = vi.fn(async () => {throw Error('Model must never run for a weekly review');});
    const app = await buildApp(loadConfig({ZZ_BOARD_DEMO:'1',ZZ_BOARD_DATA_DIR:dir}), {db,summaryRuntime:{summarize:model,models:model}});
    try {
      const before = {access:db.getCodexAccess(),jobs:db.getSyncJobs(),history:db.getHistoryStatus(),revision:db.getBoardRevision()};
      expect((await app.inject('/api/health')).json().capabilities.weeklyReview).toBe(true);
      const response = await app.inject('/api/reviews/weekly'); expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({dataStoreId:dataStoreId(dir),period:{week:'previous'},coverage:{registeredProjects:1,activeProjects:0}});
      expect((await app.inject('/api/reviews/weekly?week=current')).json().period.week).toBe('current');
      expect((await app.inject('/api/reviews/weekly?week=other')).statusCode).toBe(400);
      expect((await app.inject('/api/reviews/weekly?secret=extra')).statusCode).toBe(400);
      expect({access:db.getCodexAccess(),jobs:db.getSyncJobs(),history:db.getHistoryStatus(),revision:db.getBoardRevision()}).toEqual(before);
      expect(model).not.toHaveBeenCalled();
    } finally { await app.close(); opened.splice(opened.indexOf(db),1); rmSync(dir,{recursive:true,force:true}); }
  });
});
