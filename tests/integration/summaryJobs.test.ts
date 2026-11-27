import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BoardDatabase } from '../../src/server/database.js';
import { SummaryJobs, sourceFingerprint, validateSummary, validateSummaryResult } from '../../src/server/summaryJobs.js';
import { threadRecapSchema, boardSnapshotSchema, type ThreadRecap } from '../../src/shared/schema.js';
import { DEFAULT_SUMMARY_SETTINGS, evidenceBundleSchema } from '../../src/shared/summarySync.js';
import { bundle, source, summary, time } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { SummaryRuntimeError, type SummaryRequest } from '../../src/server/codex/summaryRuntime.js';
let db: BoardDatabase; let jobs: SummaryJobs;
afterEach(() => { jobs?.dispose(); db?.close(); jobs=undefined as unknown as SummaryJobs; db=undefined as unknown as BoardDatabase; });
const until = async (predicate: () => boolean) => { for (let i=0;i<100;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,5)); } throw new Error('Job did not settle'); };
const usage = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 40, reasoningOutputTokens: 10, totalTokens: 140 };
function recap(): ThreadRecap { const s=source(); return { summary: summary(), sources: s.evidence.map(({text: _t,...e})=>e), sourceFingerprint: sourceFingerprint(s), evidenceCheckedAt: time, summarizedAt: time, promptVersion: 'project-recap-1', model: 'gpt-5.6-sol', effort: 'medium' }; }
describe('incremental project recaps',()=>{
  it('requires the current stop to cite the new request while allowing old achievement and open action evidence', () => {
    const previous = recap(), earlier = source(), req = {...earlier.evidence[0]!,id:'next:user',turnId:'next',role:'user' as const,text:'已选方案乙，请开始实现。'};
    const next = {...earlier,requestOnlyTurnId:'next',evidence:[...earlier.evidence,req]};
    expect(()=>validateSummary(summary(),next,previous)).toThrow('当前停点');
    expect(validateSummary({...summary(),workState:'in_progress',stopPoint:'用户已选方案乙，尚无新交付记录。',stopPointRefs:[req.id]},next,previous).achievements[0]?.sourceRefs).toEqual(['a:result']);
    expect(()=>validateSummary(summary(),{...earlier,evidence:[req]},previous)).toThrow('当前停点');
  });
  it('does not let a later-finishing recap roll back the latest observation of identical content', () => {
    db = new BoardDatabase(':memory:');
    const first = source(), fp = sourceFingerprint(first), fingerprints = new Map([[first.threadKey,fp]]);
    db.prepareEvidence(bundle([first]),fingerprints);
    const later = {...first,sourceUpdatedAt:'2026-10-04T01:00:00Z',evidenceCheckedAt:'2026-10-04T02:00:00Z',runtimeState:'running' as const};
    db.prepareEvidence(bundle([later]),fingerprints);
    const olderCheck = {...later,evidenceCheckedAt:'2026-10-04T01:30:00Z',runtimeState:'idle' as const};
    db.prepareEvidence(bundle([olderCheck]),fingerprints);
    expect(db.commitRecap(first,recap())).toBe(true);
    expect(db.getBoard().threads[0]).toMatchObject({sourceUpdatedAt:later.sourceUpdatedAt,observedAt:later.evidenceCheckedAt,runtimeState:'running',
      recapOutdated:false,recap:{evidenceCheckedAt:later.evidenceCheckedAt}});
  });
  it('marks changed evidence while a recap is pending even when source timestamps match; rechecking does not resummarize it', async()=>{
    db = new BoardDatabase(':memory:'); grantSyntheticCodexAccess(db);
    let calls = 0; let release!: () => void;
    jobs = new SummaryJobs(db,{summarize:async()=>{ if (++calls === 2) await new Promise<void>(r=>{release=r;}); return {value:summary(),usage,model:'synthetic'}; }});
    jobs.create(bundle(), DEFAULT_SUMMARY_SETTINGS);
    await until(()=>jobs.list()[0]?.state==='complete');
    const changed = {...source(),readReason:'最新回合的持久化记录为中断。'};
    const next = jobs.create(bundle([changed]),{model:'gpt-6.2-sol',effort:'medium'});
    await until(()=>calls===2);
    expect(db.getBoard().threads[0]).toMatchObject({sourceUpdatedAt:time,recapOutdated:true,recap:{summary:{headline:'示例程序已构建'}}});
    release(); await until(()=>jobs.list().find(j=>j.id===next.id)?.state==='complete');
    expect(db.getBoard().threads[0]?.recapOutdated).toBe(false);
    const cached = jobs.create(bundle([{...changed,evidenceCheckedAt:'2026-10-01T00:00:00.000Z'}]),{model:'gpt-6.1-terra',effort:'high'});
    expect(cached).toMatchObject({state:'complete',skipped:1,total:0}); expect(calls).toBe(2);
  });
  it('omits only unverified optional links, never invalid claim references', () => {
    const bad = summary();
    bad.artifacts = [{ id: 'guessed', label: '报告', uri: '/synthetic/invented.md', sourceRefs: ['a:result'] }];
    bad.achievements[0]!.artifactIds = ['guessed'];
    const cleaned = validateSummaryResult(bad, source());
    expect(cleaned.omittedArtifacts).toBe(1);
    expect(cleaned.summary.artifacts).toEqual([]); expect(cleaned.summary.achievements[0]!.artifactIds).toEqual([]);
    expect(cleaned.summary.headline).toBe(bad.headline);
    expect(() => validateSummaryResult({ ...bad, stopPointRefs: ['unknown'] }, source())).toThrow('引用');
    expect(() => validateSummaryResult({ ...bad, artifacts: [{ ...bad.artifacts[0]!, sourceRefs: ['unknown'] }] }, source())).toThrow('引用');
    expect(() => validateSummaryResult({ ...bad, workState: 'waiting_for_user' }, source())).toThrow();
  });
  it('keeps known usage after a failed validation and continues independent sources', async () => {
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db); let calls=0;
    jobs=new SummaryJobs(db,{summarize:async()=>({value:++calls===1?{...summary('a'),stopPointRefs:['not-a-source']}:summary('b'),usage,model:'test'})});
    jobs.create(bundle([source('a'),source('b')]),DEFAULT_SUMMARY_SETTINGS);
    await until(()=>jobs.list()[0]?.state==='paused');
    expect(calls).toBe(2);
    expect(jobs.list()[0]).toMatchObject({completed:1,needsResubmit:true,usage:{totalTokens:280},failures:[{threadKey:source('a').threadKey,code:'invalid_reference'}],updatedThreadKeys:[source('b').threadKey]});
    expect(db.getBoard().threads.find(t=>t.threadKey===source('a').threadKey)?.recap).toBeUndefined();
    expect(jobs.list()[0]!.error).not.toContain('额度');
  });
  it('continues after a source timeout but not after quota or safety failures', async () => {
    for (const code of ['runtime_timeout', 'quota_exhausted', 'tool_boundary_unverified', 'turn_failed']) {
      jobs?.dispose(); db?.close(); db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db); let calls=0;
      jobs=new SummaryJobs(db,{summarize:async()=>{if(++calls===1)throw new SummaryRuntimeError(code,'合成原因');return {value:summary('b'),usage,model:'test'};}});
      jobs.create(bundle([source('a'),source('b')]),DEFAULT_SUMMARY_SETTINGS);
      await until(()=>jobs.list()[0]?.state==='paused');
      expect(calls).toBe(code==='runtime_timeout'?2:1);
      expect(jobs.list()[0]).toMatchObject({usage:null,failures:[{threadKey:source('a').threadKey,code}]});
    }
  });
  it('does not misclassify a database contract failure as bad model output', async () => {
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db); let calls=0;
    const invalid=z.string().safeParse(123); if(invalid.success)throw new Error('Fixture error');
    vi.spyOn(db,'commitRecap').mockImplementation(()=>{throw invalid.error;});
    jobs=new SummaryJobs(db,{summarize:async()=>({value:summary(++calls===1?'a':'b'),usage,model:'test'})});
    jobs.create(bundle([source('a'),source('b')]),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='paused');
    expect(calls).toBe(1);expect(jobs.list()[0]).toMatchObject({failures:[{threadKey:source('a').threadKey,code:'summary_failed'}],updatedThreadKeys:[]});
  });
  it('records link omissions and only marks changed committed content as updated', async () => {
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);
    const value={...summary(),artifacts:[{id:'bad',label:'报告',uri:'javascript:bad',sourceRefs:['a:result']}]};
    jobs=new SummaryJobs(db,{summarize:async()=>({value,usage,model:'test'})});
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS); await until(()=>jobs.list()[0]?.state==='complete');
    expect(jobs.list()[0]).toMatchObject({updatedThreadKeys:[source().threadKey],warnings:[{threadKey:source().threadKey,code:'artifact_omitted',count:1}]});
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS); expect(jobs.list()[0]?.updatedThreadKeys).toEqual([]);
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS,true); await until(()=>jobs.list()[0]?.state==='complete');
    expect(jobs.list()[0]?.completed).toBe(1); expect(jobs.list()[0]?.updatedThreadKeys).toEqual([]);
  });
  it('aggregates project stages across sources and identifies latest source instead of newest completion winning', async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);
    jobs=new SummaryJobs(db,{summarize:async input=>{
      const old=input.prompt.includes('old:result');
      return {value:old?{...summary('old'),workState:'waiting_for_user',nextStep:{text:'选择合成方案',kind:'decide',strength:'blocking',origin:'explicit_handoff',sourceRefs:['old:result']},nextStepReason:'explicit'}:summary('new'),usage:null,model:'test'};
    }});
    const a={...source('old'),title:'旧的未决工作线'}, b={...source('new'),title:'最新完成的工作线',sourceUpdatedAt:'2026-09-10T00:00:00.000Z'};
    jobs.create(bundle([a,b]),DEFAULT_SUMMARY_SETTINGS); await until(()=>jobs.list()[0]?.state==='complete');
    const brief=db.getBoard().projectBriefs[0]!;
    expect(brief.workState).toBe('waiting_for_user'); expect(brief.currentStage).toContain('1 条等你行动');
    expect(brief.currentStage).toContain('最新完成的工作线'); expect(brief.currentStage).toContain('2026-09-10');
  });
  it('supports V4 references and keeps the three version stages distinct',()=>{
    expect(threadRecapSchema.parse(recap()).summary.versions[0]?.stage).toBe('built');
    expect(()=>threadRecapSchema.parse({...recap(),sources:[]})).toThrow();
    const s=source();const snapshot={schemaVersion:4,summaryLanguage:'zh-CN',generatedAt:time,source:'review-project-progress',coverage:bundle().coverage,projects:bundle().projects,
      threads:[{...s,observedAt:time,recap:recap()}],projectBriefs:[],todos:[]};
    expect(boardSnapshotSchema.safeParse(snapshot).success).toBe(false); // source envelopes are not snapshots.
    const valid=boardSnapshotSchema.parse({...createDemoSnapshot(),schemaVersion:4});
    valid.threads[0]!.recap=recap();db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);db.importSnapshot(valid);
    expect(db.getBoard().threads.find(t=>t.threadKey===valid.threads[0]!.threadKey)?.recap).toEqual(recap());
  });
  it('rejects unknown projects, oversized packets and invented artifact paths',()=>{
    expect(()=>evidenceBundleSchema.parse(bundle([{...source(),projectKey:'other'}]))).toThrow();
    expect(()=>evidenceBundleSchema.parse(bundle([{...source(),evidence:[{...source().evidence[0]!,text:'x'.repeat(16001)}]}]))).toThrow();
    expect(()=>validateSummary({...summary(),artifacts:[{id:'file',label:'恶意',uri:'javascript:alert(1)',sourceRefs:['a:result']}]},source())).toThrow();
    expect(()=>validateSummary({...summary(),stopPointRefs:['missing']},source())).toThrow();
    expect(()=>validateSummary({...summary(),workState:'waiting_for_user'},source())).toThrow();
  });
  it('accepts exact evidence-file metadata but rejects relative or invented artifact locations',()=>{
    const fileSource=source();fileSource.evidence[0]!.path='/synthetic/project/REPORT.md';
    const artifact={id:'report',label:'合成报告',uri:'/synthetic/project/REPORT.md',sourceRefs:['a:result']};
    expect(()=>validateSummary({...summary(),artifacts:[artifact]},fileSource)).not.toThrow();
    expect(()=>validateSummary({...summary(),artifacts:[{...artifact,uri:'/synthetic/project/OTHER.md'}]},fileSource)).toThrow();
    fileSource.evidence[0]!.text+=' 已交付 docs/REPORT.md';
    expect(()=>validateSummary({...summary(),artifacts:[{...artifact,uri:'docs/REPORT.md'}]},fileSource)).toThrow();
  });
  it('retains user edits and undo, caches unchanged evidence across settings changes',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let calls=0;
    jobs=new SummaryJobs(db,{summarize:async()=>{calls++;return {value:summary(),usage,model:'gpt-5.6-sol'}}});
    const note=db.createNote({title:'',body:'保留便签',x:1,y:2,width:200,height:150});const history=db.getHistoryStatus();
    const first=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    expect(jobs.list()[0]).toMatchObject({id:first.id,completed:1,usage:{totalTokens:140,outputTokens:40}});
    expect(db.getBoard().threads[0]?.recap?.summary.nextStep).toBeNull();
    expect(db.getBoard().nodes.find(n=>n.id===note.id)).toEqual(note);expect(db.getHistoryStatus()).toEqual(history);
    const newer=bundle();newer.threads[0]!.evidenceCheckedAt='2026-09-09T09:00:00.000Z';newer.threads[0]!.sourceUpdatedAt='2026-09-09T09:00:00.000Z';
    expect(jobs.create(newer,{model:'other',effort:'high'})).toMatchObject({state:'complete',skipped:1});expect(calls).toBe(1);
    expect(db.getBoard().threads[0]?.recap?.summarizedAt).not.toBe(newer.threads[0]!.evidenceCheckedAt);
    db.undo();expect(db.getBoard().nodes.some(n=>n.id===note.id)).toBe(false);expect(db.getBoard().threads[0]?.recap).toBeTruthy();
  });
  it('preserves other providers and refuses a changed source identity',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db); jobs=new SummaryJobs(db,{summarize:async input=>({value:summary(input.prompt.includes('b:result')?'b':'a'),usage:null,model:'gpt-5.6-sol'})});
    jobs.create(bundle([{...source('a','chatgpt'),hostId:null}]),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    jobs.create(bundle([source('b','remote')]),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    expect(db.getBoard().threads.map(t=>t.sourceKind).sort()).toEqual(['chatgpt','remote']);
    expect(db.getBoard().threads.find(t=>t.sourceKind==='chatgpt')?.hostId).toBeUndefined();
    expect(()=>jobs.create(bundle([{...source('a','chatgpt'),threadId:'different'}]),DEFAULT_SUMMARY_SETTINGS)).toThrow('identity');
  });
  it('deduplicates in-flight work and rejects delayed results superseded by new evidence',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let release: ((v:{value:unknown;usage:null;model:string})=>void)|undefined;
    jobs=new SummaryJobs(db,{summarize:()=>new Promise(r=>{release=r;})});
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);
    expect(jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS)).toMatchObject({state:'complete',skipped:1});
    const changed={...source(),sourceUpdatedAt:'2026-09-09T10:00:00.000Z',evidence:[{...source().evidence[0]!,text:'新请求，尚未交付。'}]};
    db.prepareEvidence(bundle([changed]),new Map([[changed.threadKey,sourceFingerprint(changed)]]));
    release!({value:summary(),usage:null,model:'gpt-5.6-sol'});await until(()=>jobs.list().every(j=>j.state==='complete'));
    expect(db.getBoard().threads).toHaveLength(0);
  });
  it('keeps the original running job visible and cancellable while limiting only terminal history to 100',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let release: ((v:{value:unknown;usage:null;model:string})=>void)|undefined;
    const summarize=vi.fn(()=>new Promise<{value:unknown;usage:null;model:string}>(resolve=>{release=resolve;}));
    jobs=new SummaryJobs(db,{summarize});
    const original=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);
    expect(original.state).toBe('running');
    for(let i=0;i<100;i++)expect(jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS)).toMatchObject({state:'complete',skipped:1});
    expect(jobs.list().find(job=>job.id===original.id)).toMatchObject({state:'running'});
    expect(jobs.list().filter(job=>job.state==='complete'||job.state==='cancelled')).toHaveLength(100);
    expect(jobs.list()).toHaveLength(101);expect(summarize).toHaveBeenCalledOnce();
    expect(jobs.control(original.id,'cancel')).toMatchObject({id:original.id,state:'cancelled'});
    expect(jobs.list().find(job=>job.id===original.id)?.state).toBe('cancelled');
    expect(jobs.list().filter(job=>job.state==='complete'||job.state==='cancelled')).toHaveLength(100);
    release!({value:summary(),usage:null,model:'synthetic-model'});await new Promise(resolve=>setTimeout(resolve,5));
    expect(db.getBoard().threads).toHaveLength(0);
  });
  it('retains queued and paused jobs alongside running work when terminal rows exceed the history limit',()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);
    const summarize=vi.fn((input: SummaryRequest)=>new Promise<never>((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new Error('Synthetic cancellation.')),{once:true})));
    jobs=new SummaryJobs(db,{summarize});
    const running=jobs.create(bundle([source('running')]),DEFAULT_SUMMARY_SETTINGS);
    const queued=jobs.create(bundle([source('queued')]),DEFAULT_SUMMARY_SETTINGS);
    const paused=jobs.create(bundle([source('paused')]),DEFAULT_SUMMARY_SETTINGS);
    jobs.control(paused.id,'pause');
    for(let i=0;i<125;i++)jobs.create(bundle([source('running')]),DEFAULT_SUMMARY_SETTINGS);
    expect(jobs.list().find(job=>job.id===running.id)?.state).toBe('running');
    expect(jobs.list().find(job=>job.id===queued.id)?.state).toBe('queued');
    expect(jobs.list().find(job=>job.id===paused.id)?.state).toBe('paused');
    expect(jobs.list().filter(job=>job.state==='complete'||job.state==='cancelled')).toHaveLength(100);
    expect(jobs.list()).toHaveLength(103);expect(summarize).toHaveBeenCalledOnce();
    expect(jobs.control(queued.id,'cancel').state).toBe('cancelled');expect(jobs.control(paused.id,'cancel').state).toBe('cancelled');
    expect(jobs.list().find(job=>job.id===running.id)?.state).toBe('running');
  });
  it('pauses on unavailable runtime, cleans raw evidence, and never reports zero usage',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let calls=0;jobs=new SummaryJobs(db,{summarize:async()=>{calls++;throw new Error('sensitive test payload');}});
    const job=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='paused');
    expect(jobs.list()[0]).toMatchObject({needsResubmit:true,usage:null});expect(JSON.stringify(jobs.list())).not.toContain('sensitive');
    expect(()=>jobs.control(job.id,'resume')).toThrow('临时证据');expect(calls).toBe(1);
  });
  it('cancellation discards a late result and leaves previous state intact',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let release: ((v:{value:unknown;usage:null;model:string})=>void)|undefined;
    jobs=new SummaryJobs(db,{summarize:()=>new Promise(r=>{release=r;})});
    const job=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);jobs.control(job.id,'cancel');
    release!({value:summary(),usage:null,model:'gpt-5.6-sol'});await new Promise(r=>setTimeout(r,10));
    expect(jobs.list()[0]?.state).toBe('cancelled');expect(db.getBoard().threads).toHaveLength(0);
  });
  it('full snapshot import blocks in-flight sources even when absent from the snapshot',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let release: ((v:{value:unknown;usage:null;model:string})=>void)|undefined;
    jobs=new SummaryJobs(db,{summarize:()=>new Promise(r=>{release=r;})});jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);
    db.importSnapshot(createDemoSnapshot());release!({value:summary(),usage:null,model:'gpt-5.6-sol'});
    await until(()=>jobs.list()[0]?.state==='complete');expect(db.getBoard().threads.some(t=>t.threadKey===source().threadKey)).toBe(false);
  });
  it.each([true,false])('marks partial usage unknown regardless of response order (%s)',async(knownFirst)=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let index=0;
    jobs=new SummaryJobs(db,{summarize:async()=>{const id=index++===0?'a':'b';return {value:summary(id),usage:(id==='a')===knownFirst?usage:null,model:'gpt-5.6-sol'};}});
    jobs.create(bundle([source('a'),source('b')]),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    expect(jobs.list()[0]?.usage).toBeNull();
  });
  it('resuming a running job is idempotent and does not make another model call',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let calls=0;let release: ((v:{value:unknown;usage:null;model:string})=>void)|undefined;
    jobs=new SummaryJobs(db,{summarize:()=>{calls++;return new Promise(r=>{release=r;});}});
    const job=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);expect(jobs.control(job.id,'resume').state).toBe('running');
    release!({value:summary(),usage:null,model:'gpt-5.6-sol'});await until(()=>jobs.list()[0]?.state==='complete');expect(calls).toBe(1);
  });
  it('an import epoch rejects old results even after identical evidence is resubmitted',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);const releases:Array<(v:{value:unknown;usage:null;model:string})=>void>=[];
    jobs=new SummaryJobs(db,{summarize:()=>new Promise(r=>{releases.push(r);})});
    const old=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);db.importSnapshot(createDemoSnapshot());
    const fresh=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);expect(fresh.total).toBe(1);
    releases[0]!({value:summary(),usage:null,model:'gpt-5.6-sol'});await until(()=>releases.length===2);
    expect(jobs.list().find(j=>j.id===old.id)?.completed).toBe(0);
    expect(db.getBoard().threads.some(t=>t.threadKey===source().threadKey)).toBe(false);
    releases[1]!({value:summary(),usage:null,model:'gpt-5.6-sol'});await until(()=>jobs.list().find(j=>j.id===fresh.id)?.state==='complete');
    expect(db.getBoard().threads.some(t=>t.threadKey===source().threadKey)).toBe(true);
  });
  it('retries transient transport once but keeps potentially partial usage unknown',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let calls=0;
    jobs=new SummaryJobs(db,{summarize:async()=>{if(++calls===1)throw new SummaryRuntimeError('temporary_network_error','暂时不可用');return {value:summary(),usage,model:'gpt-5.6-sol'};}});
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    expect(calls).toBe(2);expect(jobs.list()[0]?.usage).toBeNull();
  });
  it('pauses, resumes and restarts only the interrupted request without committing its late output',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let calls=0;
    jobs=new SummaryJobs(db,{summarize:async input=>{if(++calls===1)return new Promise((_resolve,reject)=>input.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));return {value:summary(),usage,model:'gpt-5.6-sol'};}});
    const job=jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);expect(jobs.control(job.id,'pause').state).toBe('paused');
    jobs.control(job.id,'resume');await until(()=>jobs.list()[0]?.state==='complete');
    expect(calls).toBe(2);expect(jobs.list()[0]?.completed).toBe(1);expect(jobs.list()[0]?.usage).toBeNull();
  });
  it('keeps distinct same-kind actions until explicit fresh evidence retires the earlier one',async()=>{
    db=new BoardDatabase(':memory:');grantSyntheticCodexAccess(db);let text='请测试缩放';let resolved: string|undefined;
    jobs=new SummaryJobs(db,{summarize:async()=>({value:{...summary(),nextStep:{text,kind:'test',strength:'blocking',origin:'explicit_handoff',sourceRefs:['a:result']},nextStepReason:'explicit',resolvedTodos:resolved?[{todoKey:resolved,sourceRefs:['a:result']}]:[]},usage:null,model:'gpt-5.6-sol'})});
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS);await until(()=>jobs.list()[0]?.state==='complete');
    const first=db.getBoard().todos[0]!.todoKey;text='请测试导出';
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS,true);await until(()=>jobs.list()[0]?.state==='complete');
    expect(db.getBoard().todos.filter(t=>!t.missingSince)).toHaveLength(2);resolved=first;
    jobs.create(bundle(),DEFAULT_SUMMARY_SETTINGS,true);await until(()=>jobs.list()[0]?.state==='complete');
    expect(db.getBoard().todos.filter(t=>!t.missingSince)).toHaveLength(1);
  });
});
