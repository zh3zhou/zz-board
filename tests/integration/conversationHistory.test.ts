import { afterEach,describe,expect,it,vi } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { ProjectRefresh } from '../../src/server/projectRefresh.js';
import { SummaryJobs } from '../../src/server/summaryJobs.js';
import { boardSnapshotSchema } from '../../src/shared/schema.js';
import type { ConversationBatch } from '../../src/shared/conversationHistory.js';
import { extractConversationTurns } from '../../src/server/conversationEvidence.js';
import { summary } from '../fixtures/summary.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import type { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';

const time='2026-09-28T08:00:00.000Z',cwd='E:\\synthetic';
let db:BoardDatabase;let jobs:SummaryJobs|undefined;
afterEach(()=>{jobs?.dispose();jobs=undefined;db?.close();});
function seed(){db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);db.importSnapshot(boardSnapshotSchema.parse({schemaVersion:1,generatedAt:time,source:'review-project-progress',
  projects:[{projectKey:'p',name:'合成',cwd,hostId:'local',observedAt:time}],threads:[{threadKey:'t',threadId:'native',projectKey:'p',hostId:'local',sourceKind:'codex',title:'合成对话',observedAt:time,sourceUpdatedAt:time}],
  coverage:{projectsFound:1,threadsFound:1,deepRead:0,fileChecked:0,truncated:false,inaccessible:[]}}));return db;}
function page(ids=['a','b'],next:string|null='old'){return {thread:{id:'native',cwd,updatedAt:time,turns:ids.map(id=>({id,status:'completed',startedAt:time,completedAt:time,items:[
  {id:'request',type:'userMessage',text:'请讨论方案。'},{id:'answer',type:'agentMessage',phase:'final_answer',text:`${id} 只讨论，没有实施。`}]}))},conversationRead:{nextCursor:next}};}
function batch(ids=['a','b']):ConversationBatch { const turns=db.conversations.prepare('t',extractConversationTurns(page(ids),'native').turns,false);return {conversationKey:'batch',projectKey:'p',threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,fingerprint:'fingerprint',turns,context:[]}; }
const output=(b:ConversationBatch)=>({turns:b.turns.map(t=>({turnId:t.turnId,title:'方案讨论',summary:'讨论方案，尚未选择或实施。',continuesPrevious:false,reference:null,sourceRefs:[t.evidence[0]!.id]}))});
async function settled(){await vi.waitFor(()=>expect(jobs!.list().some(j=>['running','queued'].includes(j.state))).toBe(false));}

describe('persisted conversation history and shared queue',()=>{
  it('preserves canvas history, per-turn fingerprints, unread revisions and late result protection',()=>{
    seed(); const note=db.createNote({title:'',body:'不修改',x:0,y:0,width:200,height:100});const before=db.getHistoryStatus();
    const b=batch();db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,hasEarlier:true,nextCursor:'old',coverage:[]});
    expect(db.conversations.columnPage('t')).toMatchObject({knownTurns:2,pendingTurns:2});
    expect(db.commitConversations(b,output(b).turns,db.getSummaryEpoch())).toBe(true);
    expect(db.conversations.columnPage('t')).toMatchObject({knownTurns:2,pendingTurns:0});
    expect(db.conversations.page('t')).toHaveLength(2);expect(db.conversations.cached('t',b.turns[0]!)).toBe(true);
    db.conversations.markRead('p',[{threadKey:'t',turnId:'a',revision:1}]);expect(db.conversations.page('t')[0]!.unread).toBe(false);
    db.conversations.prepare('t',[{...b.turns[0]!,fingerprint:'changed'}],false);
    expect(db.commitConversations(b,output(b).turns,db.getSummaryEpoch())).toBe(false);
    expect(db.getHistoryStatus()).toEqual(before);expect(db.getBoard().nodes.find(n=>n.id===note.id)?.body).toBe('不修改');
  });
  it('does not advance an older cursor until all page batches commit and exact reads do not mark newer revisions',()=>{
    seed();db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,hasEarlier:true,nextCursor:'old',coverage:[]});
    const b=batch(); b.olderPage={cursor:'old',nextCursor:'older',beforeTurnId:'a',turns:b.turns.map(t=>({turnId:t.turnId,fingerprint:t.fingerprint}))};
    const first={...b,turns:[b.turns[0]!]};db.commitConversations(first,output(first).turns,db.getSummaryEpoch());
    expect(db.conversations.metadata('t')!.nextCursor).toBe('old');
    db.commitConversations(b,output(b).turns,db.getSummaryEpoch());expect(db.conversations.metadata('t')!.nextCursor).toBe('older');
    const revised=output(b).turns.map(t=>({...t,summary:'本轮讨论修改了方案。'}));db.commitConversations(b,revised,db.getSummaryEpoch());
    db.conversations.markRead('p',[{threadKey:'t',turnId:'a',revision:1}]);expect(db.conversations.page('t')[0]!.unread).toBe(true);
  });
  it('initializes only the opened project, batches turns once with recap, and unchanged refresh uses zero calls',async()=>{
    seed();let clock=Date.parse(time);
    const runner={summarize:vi.fn(async(input:{prompt:string})=>{
      const raw=input.prompt.split('证据：')[1]!.split('\n同一次输出')[0]!;const b=JSON.parse(raw) as ConversationBatch;
      const s=summary();s.stopPointRefs=['b:answer'];s.achievements=[];s.versions=[];
      return {value:{...output(b),summary:{...s,milestones:[]}},usage:null,model:'synthetic'};
    })};
    jobs=new SummaryJobs(db,runner);
    const reader={listProjectThreads:async()=>({data:[{id:'native',cwd,name:'合成',updatedAt:time}]}),readThread:async()=>page(),readConversationPage:vi.fn(async()=>page())};
    const refresh=new ProjectRefresh(db,reader,jobs,()=>new Date(clock));
    expect(db.conversations.enabled('p')).toBe(false);expect(runner.summarize).not.toHaveBeenCalled();
    const result=await refresh.conversations('p');expect(result.job).not.toBeNull();await settled();
    expect(jobs.list()[0]!.state).toBe('complete');expect(runner.summarize).toHaveBeenCalledTimes(1);
    expect(db.conversations.page('t')).toHaveLength(2);expect(db.getBoard().threads[0]!.recap).toBeDefined();
    clock+=20000;await refresh.refresh('p');await settled();expect(runner.summarize).toHaveBeenCalledTimes(1);
    expect(reader.readConversationPage).toHaveBeenCalledTimes(2);
  });
  it('deduplicates concurrent batches and cancellation cannot commit a late model response',async()=>{
    seed();const b=batch();let resolve!:(x:unknown)=>void;
    const runner={summarize:vi.fn(()=>new Promise<{value:unknown;usage:null;model:string}>(r=>{resolve=value=>r({value,usage:null,model:'synthetic'});} ))};
    jobs=new SummaryJobs(db,runner);const a=jobs.createConversations([b],{model:'synthetic',effort:'medium'});const duplicate=jobs.createConversations([b],{model:'synthetic',effort:'medium'});
    expect(duplicate.total).toBe(0);jobs.control(a.id,'cancel');resolve(output(b));await settled();
    expect(db.conversations.page('t')).toHaveLength(0);expect(runner.summarize).toHaveBeenCalledTimes(1);
  });
  it('retains enabled state and summaries across restart without storing original message text',()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zz-conversation-'));const file=path.join(directory,'synthetic.sqlite');
    seed();db.close();db=new BoardDatabase(file);db.conversations.enable('p');const b=batch();db.commitConversations(b,output(b).turns,db.getSummaryEpoch());db.close();
    db=new BoardDatabase(file);expect(db.conversations.enabled('p')).toBe(true);expect(db.conversations.page('t')).toHaveLength(2);
    expect(JSON.stringify(db.conversations.page('t'))).not.toContain('请讨论方案。');
    db.close();db=undefined as unknown as BoardDatabase;fs.rmSync(directory,{recursive:true,force:true});
  });
  it('exposes guarded project-scoped pages and read receipts without model calls on GET',async()=>{
    seed();const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zz-conversation-api-'));
    const runner={models:async()=>[],summarize:vi.fn()};const sourceReader={dispose(){},listProjectThreads:async()=>({data:[]}),readThread:async()=>page()};
    const app=await buildApp({...loadConfig({ZZ_BOARD_DATA_DIR:directory}),databasePath:':memory:'},{db,codex:sourceReader as unknown as CodexAppServerClient,summaryRuntime:runner});
    try {
      const url='/api/projects/p/conversations';expect((await app.inject(url)).json()).toMatchObject({projectKey:'p',enabled:false});
      expect(runner.summarize).not.toHaveBeenCalled();
      expect((await app.inject({method:'POST',url:`${url}/refresh`})).statusCode).toBe(403);
      expect((await app.inject({method:'POST',url:`${url}/read`,payload:{items:[]}})).statusCode).toBe(403);
      expect((await app.inject('/api/projects/wrong/conversations/turns?threadKey=t')).statusCode).toBe(404);
      expect((await app.inject({method:'POST',url:`${url}/read`,headers:{'x-zz-board-mutation':'1'},payload:{items:[]}})).statusCode).toBe(200);
    } finally {await app.close();db=undefined as unknown as BoardDatabase;fs.rmSync(directory,{recursive:true,force:true});}
  });
  it('inserts newly readable missing turns without ordinal collisions, stale commits or unstable ID paging',()=>{
    seed();db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,hasEarlier:false,nextCursor:null,coverage:[]});
    const initial=page(['a','b','c']);initial.thread.turns[1]!.items=[];
    const turns=db.conversations.prepare('t',extractConversationTurns(initial,'native').turns,false);
    const first={...batch([]),turns};db.commitConversations(first,output(first).turns,db.getSummaryEpoch());
    const newer=db.conversations.prepare('t',extractConversationTurns(page(['a','b','c']),'native').turns,false);
    const second={...first,turns:newer};db.commitConversations(second,output(second).turns,db.getSummaryEpoch());
    db.commitConversations(first,output(first).turns,db.getSummaryEpoch());
    const all=db.conversations.page('t');expect(all.map(t=>[t.turnId,t.ordinal])).toEqual([['a',0],['b',1],['c',2]]);
    expect(db.conversations.columnPage('t',undefined,'c').turns.map(t=>t.turnId)).toEqual(['a','b']);
    expect(db.conversations.metadata('t')!.orderingRevision).toBeGreaterThan(0);
  });
  it('does not link separated recent windows and inserts later gap pages before their source cursor anchor',()=>{
    seed();const old=batch(['a','b']);db.commitConversations(old,output(old).turns,db.getSummaryEpoch());
    db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,hasEarlier:true,nextCursor:'middle',cursorBeforeTurnId:'x',coverage:[]});
    const latest=batch(['x','y']);expect(latest.turns[0]!.previousTurnId).toBeNull();db.commitConversations(latest,output(latest).turns,db.getSummaryEpoch());
    const middle={...latest,turns:db.conversations.prepare('t',extractConversationTurns(page(['m','n']),'native').turns,true)};
    db.commitConversations(middle,output(middle).turns,db.getSummaryEpoch());
    expect(db.conversations.page('t').map(t=>t.turnId)).toEqual(['a','b','m','n','x','y']);
  });
  it('clears cached continuation when the predecessor changes and prevents a late response restoring that relation',()=>{
    seed();const b=batch();const related=output(b).turns;related[1]!.continuesPrevious=true;db.commitConversations(b,related,db.getSummaryEpoch());
    expect(db.conversations.page('t')[1]!.continuesPrevious).toBe(true);
    db.conversations.prepare('t',[{...b.turns[0]!,fingerprint:'new topic'}],false);
    expect(db.conversations.page('t')[1]!.continuesPrevious).toBe(false);
    const pending={...b,turns:[b.turns[1]!]};db.commitConversations(pending,[related[1]!],db.getSummaryEpoch());
    expect(db.conversations.page('t')[1]!.continuesPrevious).toBe(false);
  });
  it('uses newer source metadata rather than an old cached column when selecting the recent three',()=>{
    seed();db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:'2026-01-01T00:00:00.000Z',checkedAt:time,hasEarlier:false,nextCursor:null,coverage:[]});
    const thread=db.getBoard().threads[0]!;
    const list=[thread,...['u','v','w'].map((key,i)=>({...thread,threadKey:key,sourceUpdatedAt:`2026-09-${25+i}T08:00:00.000Z`}))];
    expect(db.conversations.history('p',list).threads.map(t=>t.threadKey)).toContain('t');
    expect(db.conversations.history('p',list).threads.find(t=>t.threadKey==='t')!.sourceUpdatedAt).toBe(time);
  });
  it('initializes twenty-turn history even if opened during an existing ordinary six-turn collection',async()=>{
    seed();let release!:(v:ReturnType<typeof page>)=>void;
    const s={...summary(),stopPointRefs:['b:answer'],achievements:[],versions:[],milestones:[]};
    const runner={summarize:vi.fn(async(input:{prompt:string})=>({model:'synthetic',usage:null,value:input.prompt.includes('证据：') ? {...output(JSON.parse(input.prompt.split('证据：')[1]!.split('\n同一次输出')[0]!) as ConversationBatch),...(input.prompt.includes('同一次输出')?{summary:s}:{})} : s}))};
    jobs=new SummaryJobs(db,runner);
    const reader={listProjectThreads:async()=>({data:[]}),readThread:async()=>page(),readRecentThread:vi.fn(()=>new Promise<ReturnType<typeof page>>(r=>{release=r;})),readConversationPage:vi.fn(async()=>page())};
    const refresh=new ProjectRefresh(db,reader,jobs);const ordinary=refresh.refresh('p');await vi.waitFor(()=>expect(reader.readRecentThread).toHaveBeenCalled());
    const expanded=refresh.conversations('p');release(page());await ordinary;await expanded;await settled();
    expect(reader.readConversationPage).toHaveBeenCalledTimes(1);expect(db.conversations.page('t')).toHaveLength(2);
    expect(runner.summarize.mock.calls.filter(c=>c[0].prompt.includes('同一次输出'))).toHaveLength(0);
  });
  it('preserves source gap cursors and advances ordering revision only for cached-row reordering through real collection',async()=>{
    seed();let clock=Date.parse(time);let current=page();
    const runner={summarize:vi.fn(async(input:{prompt:string})=>{
      const data=JSON.parse(input.prompt.split('证据：')[1]!.split('\n同一次输出')[0]!) as ConversationBatch;
      return {model:'synthetic',usage:null,value:{...output(data),...(input.prompt.includes('同一次输出') ? {summary:{...summary(),stopPointRefs:[`${data.turns.at(-1)!.turnId}:answer`],achievements:[],versions:[],milestones:[]}} : {})}};
    })};jobs=new SummaryJobs(db,runner);
    const reader={listProjectThreads:async()=>({data:[]}),readThread:async()=>current,readConversationPage:async(_id:string,cursor?:string)=>cursor==='gap' ? page(['m','n'],'old') : current};
    const refresh=new ProjectRefresh(db,reader,jobs,()=>new Date(clock));await refresh.conversations('p');await settled();
    const initial=db.conversations.metadata('t')!.orderingRevision;
    current=page(['x','y'],'gap');clock+=20000;await refresh.refresh('p');await settled();
    expect(db.conversations.metadata('t')).toMatchObject({nextCursor:'gap',cursorBeforeTurnId:'x',orderingRevision:initial});
    expect(db.conversations.page('t').find(t=>t.turnId==='x')!.previousTurnId).toBeNull();
    await refresh.earlier('p','t','gap');await settled();
    expect(db.conversations.metadata('t')).toMatchObject({nextCursor:'old',cursorBeforeTurnId:'m',orderingRevision:initial!+1});
    expect(db.conversations.page('t').map(t=>t.turnId)).toEqual(['a','b','m','n','x','y']);
  });
  it('rolls back an interrupted reorder atomically and can prepare again after the error',()=>{
    seed();const b=batch();db.commitConversations(b,output(b).turns,db.getSummaryEpoch());
    db.conversations.updateColumn('p',{threadKey:'t',title:'合成',sourceUpdatedAt:time,checkedAt:time,hasEarlier:true,nextCursor:'before',cursorBeforeTurnId:'a',coverage:[]});
    const before=db.conversations.columnPage('t');
    const bad={...b.turns[0]!,turnId:'older',fingerprint:null as unknown as string};
    expect(()=>db.conversations.prepare('t',[bad],true)).toThrow();
    expect(db.conversations.columnPage('t')).toEqual(before);
    const good=db.conversations.prepare('t',[{...bad,fingerprint:'valid'}],true);
    expect(good[0]!.ordinal).toBe(0);expect(db.conversations.page('t').map(t=>t.ordinal)).toEqual([1,2]);
  });
});
