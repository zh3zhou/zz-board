import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BoardThread, ThreadRecap } from '../../src/shared/schema.js';
import { artifactTarget, ProjectDetail, ThreadSummary } from '../../src/web/ProjectDetail.js';
import { recapNeedsUpdate } from '../../src/shared/projectProgress.js';
import { BubbleHoverPreview, hoverPreviewContent } from '../../src/web/BubbleHoverPreview.js';
import { actionEvidenceThread, actionRecordTime, awaitsResponse, historicalAction, projectActions } from '../../src/web/projectActions.js';
import { projectReading, shortRecordDate } from '../../src/web/projectContextReading.js';
import { projectSignals, type ProjectBubbleContext } from '../../src/web/projectCanvas.js';
import { ProjectModelChoices, SyncJobCard, UsageSummary } from '../../src/web/SummarySyncPanel.js';
import type { SyncJob } from '../../src/shared/summarySync.js';

const time = '2026-09-01T00:00:00Z';
function recap(): ThreadRecap {
  return { sources: [{ id: 'source', role: 'assistant', occurredAt: time, turnId: 'turn', path: null }], sourceFingerprint: 'a'.repeat(64), evidenceCheckedAt: '2026-09-03T00:00:00Z', summarizedAt: '2026-09-02T00:00:00Z', promptVersion: 'test', model: 'model', effort: 'medium', summary: {
    headline: '阶段交付已完成', stopPoint: '交付后尚未提出下一步', stopPointRefs: ['source'], workState: 'stage_closed', confidence: 'high',
    achievements: [{ id: 'result', title: '完成合成模块', detail: '', occurredAt: time, sourceRefs: ['source'], artifactIds: ['artifact'] }],
    artifacts: [{ id: 'artifact', label: '交付说明', uri: 'E:\\synthetic\\report.md', sourceRefs: ['source'] }],
    versions: [{ version: '1.2.0', stage: 'built', sourceRefs: ['source'] }], nextStep: null, nextStepReason: 'not_stated', resolvedTodos: []
  } };
}
function thread(key: string, patch: Partial<BoardThread> = {}): BoardThread { return { threadKey: key, threadId: key, title: `原始对话-${key}`, displayTitle: `合成对话-${key}`, sourceKind: 'snapshot', runtimeState: 'idle', workState: 'stage_closed', humanAction: 'none', actionStrength: 'none', confidence: 'high', stopPoint: '旧版停点', evidence: '合成证据', observedAt: time, lastObservedAt: time, missingSince: null, sourceUpdatedAt: time, ...patch }; }
function context(threads: BoardThread[]): ProjectBubbleContext { return { project: { projectKey: 'test', name: '合成项目', observedAt: time }, threads, todos: [], memberNodeIds: [] }; }
function html(threads: BoardThread[]) { return renderToStaticMarkup(createElement(ProjectDetail, { context: context(threads), focusedThreadKey: null, view: 'overview' })); }
function preview(project: ProjectBubbleContext) {
  return hoverPreviewContent(bubbleData(project));
}
function bubbleData(project: ProjectBubbleContext) {
  return {project, record:{id:'p',kind:'task' as const,projectKey:'test',threadKey:null,archivedAt:null,title:'合成项目',body:'',
    x:0,y:0,width:180,height:180,zIndex:1,lastViewedAt:null,revision:0,createdAt:time,updatedAt:time},annotationCount:0,selected:false,canResize:false,onResizeEnd:()=>{}};
}

describe('project recaps', () => {
  it('reads the concrete change and recorded test handoff when several accounts cite the same message', () => {
    const r = recap();
    r.summary.versions = [];
    r.summary.milestones = [{id:'delivery',kind:'achievement',title:'候选版交付与自动验证',resolution:'verified',
      result:'助手报告相关修复与文档交付；42 项自动测试通过，两名独立审查完成。',version:null,
      problem:null,options:[],decision:null,occurredAt:time,sourceRefs:['source']}];
    r.summary.achievements[0] = {...r.summary.achievements[0]!,title:'交付可试用的候选版',
      detail:'助手报告修复了裁切标线、套印、分色和双页分页问题；42 项自动测试通过，审查及启动关闭检查完成。'};
    r.summary.nextStep = {kind:'test',strength:'recommended',origin:'explicit_handoff',
      text:'按交接清单实测双页装订，以及展开后的纸张方向。',sourceRefs:['source']};
    r.summary.stopPoint = '候选版已交付。实机验收尚待进行。';
    const t = thread('样书',{recap:r}), ctx = context([t]);
    const [line] = projectReading(ctx);
    expect(line?.text).toMatch(/候选版.*裁切标线/);
    expect(line?.text).toContain('双页分页');
    expect(line?.text).toContain('纸张方向');
    expect(line?.text).not.toMatch(/42 项|审查|助手报告|文档交付|自动验证|关闭检查/);
    expect(line?.sourceRefs).toEqual(['source']);
    expect(preview(ctx)).toMatchObject({summary:line!.text,action:''});
    const original = renderToStaticMarkup(createElement(ThreadSummary,{thread:t}));
    expect(original).toContain('42 项自动测试通过');
    r.summary.nextStep.text = '实测纸盒、套印，以及恢复双页定位。';
    expect(projectReading(ctx)[0]!.text).toContain('实测能否恢复双页定位');
    for (const check of ['实测 X2 纸盒、套印，以及恢复双页定位', '仅在 A4 上实测纸盒、套印，以及恢复双页定位',
      '实测纸盒未装入、套印失准，以及恢复双页定位', '暂时不要实测双页定位']) {
      r.summary.nextStep.text = check + '。';
      expect(projectReading(ctx)[0]!.text).toContain(check);
    }
    r.sources.push({...r.sources[0]!,id:'another'});
    r.summary.nextStep.sourceRefs = ['another'];
    expect(projectReading(ctx)[0]!.text).not.toContain('双页定位');
    r.summary.milestones = [];
    r.summary.nextStep.sourceRefs = ['source'];
    r.summary.achievements[0]!.occurredAt = '2026-04-28';
    expect(projectReading(ctx)[0]!.text).not.toContain('双页定位');
  });

  it('keeps measured outcomes and limits, even next to test totals, and preserves a bounded status alone', () => {
    const r = recap();
    r.summary.versions = [];
    const ctx = context([thread('输纸',{recap:r})]);
    const achievement = r.summary.achievements[0]!;
    achievement.title = '更新输纸';
    achievement.detail = '出纸从 9 秒减至 3 秒；12 项测试通过；仅在 A4 纸上验证，A3 仍会卡纸。';
    const fact = projectReading(ctx)[0]!.text;
    expect(fact).toContain('9 秒减至 3 秒'); expect(fact).toContain('仅在 A4'); expect(fact).toContain('A3 仍会卡纸');
    expect(fact).not.toContain('12 项');
    achievement.detail = '分页时保留纸张方向；9 组核心、14 组 Linux 测试通过。';
    expect(projectReading(ctx)[0]!.text).toContain('分页时保留纸张方向');
    expect(projectReading(ctx)[0]!.text).not.toContain('14 组');
    achievement.title = '候选版交付与自动验证';
    achievement.detail = '候选版已通过自动测试，实机还未验证。';
    const status = projectReading(ctx)[0]!.text;
    expect(status).toContain('候选版已通过自动测试'); expect(status).toContain('实机还未验证');
    expect(status).not.toContain('候选版交付与自动验证');
    achievement.title = '助手报告模板 3.0';
    for (const detail of ['12 项测试的延迟从 80 ms 降至 15 ms 并通过。', '12 项 R2 裁切测试通过。',
      '12 项裁切定位测试通过。', '12 项 Windows 测试通过。',
      '12 项测试全部完成。', '仅在 A4 上，12 项测试通过。', '12 项测试未能全部通过。']) {
      achievement.detail = detail;
      expect(projectReading(ctx)[0]!.text).toContain(achievement.title);
      expect(projectReading(ctx)[0]!.text).toContain(detail);
    }
  });
  it('leads with the current delivery and leaves the older action with its dated source until retired', () => {
    const current = recap();
    current.summary = {...current.summary,workState:'waiting_for_user',stopPoint:'候选已交付，等待选择',
      nextStep:{kind:'decide',strength:'blocking',origin:'explicit_handoff',text:'选择方案乙',sourceRefs:['source']},nextStepReason:'explicit'};
    const ctx = context([thread('other',{recap:recap()}),thread('decision',{recap:current,recapOutdated:true})]);
    ctx.todos = [{todoKey:'saved',projectKey:'test',sourceThreadKeys:['decision'],kind:'decide',strength:'blocking',title:'选择',minimumAction:'选择方案乙',
      evidence:'明确交接',whyNow:'',unlocks:'',confidence:'high',observedAt:time,lastObservedAt:time,missingSince:null}];
    expect(projectSignals(ctx).actionRequired).toBe(true); expect(projectActions(ctx)).toHaveLength(1);
    expect(preview(ctx)).toMatchObject({summary:expect.stringContaining('完成合成模块'),action:'',source:expect.stringContaining('原始对话-other')});
    const view = renderToStaticMarkup(createElement(ProjectDetail,{context:ctx,focusedThreadKey:null,view:'overview'}));
    expect(view.match(/选择方案乙/g)).toHaveLength(1); expect(view).toContain('上次记录，待核对'); expect(view).toContain(shortRecordDate(time)); expect(view).toContain('摘要待更新');
    current.summary = {...current.summary,nextStep:null,workState:'stage_closed',nextStepReason:'not_stated',resolvedTodos:[{todoKey:'saved',sourceRefs:['source']}]};
    expect(projectSignals(ctx).actionRequired).toBe(false); expect(preview(ctx).action).toBe('');
    expect(renderToStaticMarkup(createElement(ProjectDetail,{context:ctx,focusedThreadKey:null,view:'overview'}))).not.toContain('选择方案乙');
  });
  it('does not turn missing conversations or old suggestions into a current action', () => {
    const missing = thread('missing',{workState:'waiting_for_user',humanAction:'approve',actionStrength:'blocking',missingSince:time,stopPoint:'已失去覆盖的停点'});
    const active = thread('active',{humanAction:'review',actionStrength:'recommended',stopPoint:'最近有效的停点'});
    const ctx=context([missing,active]);
    ctx.todos=[{todoKey:'old',projectKey:'test',sourceThreadKeys:['missing'],kind:'approve',strength:'blocking',title:'历史批准',minimumAction:'历史批准',
      evidence:'合成',whyNow:'',unlocks:'',confidence:'high',observedAt:time,lastObservedAt:time,missingSince:null}];
    expect(preview(ctx)).toMatchObject({action:'',summary:'最近有效的停点',qualifier:''});
    expect(projectSignals(ctx).actionRequired).toBe(false);
    expect(preview(context([missing]))).toMatchObject({qualifier:expect.stringContaining('上次记录'),summary:'已失去覆盖的停点',action:''});
  });
  it('preserves recorded order without classification and marks only updated conversations', () => {
    const sources = Array.from({ length: 5 }, (_, i) => thread(`line-${i}`, { sidebarIndex: i, sourceUpdatedAt: `2026-09-${10+i}T00:00:00Z`, recap: recap() }));
    const text = renderToStaticMarkup(createElement(ProjectDetail, {context:context(sources),focusedThreadKey:null,view:'threads',updatedThreadKeys:['line-2']}));
    expect(text).toContain('对话 · 5'); expect(text).not.toContain('5 条阶段收口'); expect(text).not.toContain('当前阶段');
    expect(text.indexOf('line-0')).toBeLessThan(text.indexOf('line-4'));
    expect(text).toContain('对话更新于'); expect(text).not.toContain('结构化');
    expect(text.match(/class="conversation-update"/g)).toHaveLength(1);
    expect(text.match(/class="thread-summary {2}has-update"/g)).toHaveLength(1);
  });
  it('preserves parallel achievements and puts newest first without claiming a running version', () => {
    const first = recap(); const second = recap(); second.summary.achievements[0] = { ...second.summary.achievements[0], title: '研究复盘完成', occurredAt: '2026-09-02T00:00:00Z' };
    const text = html([thread('one', { recap: first }), thread('two', { recap: second })]);
    expect(text).toContain('原始对话-one'); expect(text).toContain('原始对话-two');
    expect(text.indexOf('研究复盘完成')).toBeLessThan(text.indexOf('完成合成模块'));
    expect(text).not.toContain('1.2.0'); expect(text).not.toContain('这条对话的版本记录'); expect(text).not.toContain('运行已核验');
    const versionOnly = recap(); versionOnly.summary.achievements = [];
    expect(html([thread('版本',{recap:versionOnly})])).toContain('1.2.0 · 包已构建');
    expect(text).not.toContain('<h3>明确待办</h3>');
  });
  it('gives one work line one place in the overview, with its full older achievements in the thread', () => {
    const value = recap(); value.summary.achievements = Array.from({ length: 5 }, (_, i) => ({ ...value.summary.achievements[0], id: `${i}`, title: `成果${i}` }));
    const source = thread('a', {recap:value});
    const text = html([source]); expect(text).toContain('成果0'); expect(text).not.toContain('成果4');
    expect(renderToStaticMarkup(createElement(ThreadSummary,{thread:source}))).toContain('成果4');
  });
  it('retains V1–3 stop points without inventing unknown next steps', () => {
    const text = html([thread('old')]); expect(text).toContain('旧版停点'); expect(text).not.toContain('下一步');
  });
  it('separates source, checked, and summary timestamps', () => {
    const text = renderToStaticMarkup(createElement(ThreadSummary, { thread: thread('a', { recap: recap() }) }));
    expect(text).toContain('对话更新于'); expect(text).toContain('检查于'); expect(text).toContain('整理于');
    expect(text).not.toContain('<details open');
    expect(text).toContain(shortRecordDate(time));
    expect(text).toMatch(/检查于 <time dateTime="2026-09-03T00:00:00Z">[^<]*\d\d:\d\d:\d\d/);
    expect(text).toMatch(/整理于 <time dateTime="2026-09-02T00:00:00Z">[^<]*\d\d:\d\d:\d\d/);
  });
  it('marks newer source records without dropping the previous explicit action', () => {
    const value = recap(); value.summary.nextStep = { text: '核对合成结果', kind: 'review', strength: 'blocking', origin: 'user_request', sourceRefs: ['source'] }; value.summary.nextStepReason = 'explicit';
    const source = thread('new', { recap: value, sourceUpdatedAt: '2026-09-04T00:00:00Z' });
    expect(recapNeedsUpdate(source)).toBe(true);
    const text = html([source]); expect(text).toContain('摘要待更新'); expect(text).toContain('核对合成结果');
    expect(recapNeedsUpdate(thread('old', { recap: value }))).toBe(false);
  });
  it('does not promote legacy optional or recommended suggestions into user blockers', () => {
    for (const strength of ['optional', 'recommended'] as const) {
      const result = projectSignals(context([thread('old', { humanAction: 'review', actionStrength: strength })]));
      expect(result.actionRequired).toBe(false); expect(result.workState).toBe('stage_closed');
    }
  });
  it('honors an explicit recap next step and ignores stale thread action fields', () => {
    const value = recap(); expect(projectSignals(context([thread('a', { recap: value, humanAction: 'review', actionStrength: 'blocking' })])).actionRequired).toBe(false);
    value.summary.nextStep = { text: '请选择已经讨论的方案', kind: 'decide', strength: 'recommended', origin: 'user_request', sourceRefs: ['source'] }; value.summary.nextStepReason = 'explicit';
    expect(projectSignals(context([thread('a', { recap: value })]))).toMatchObject({actionRequired:true,workState:'stage_closed'});
    expect(html([thread('a', { recap: value })])).toContain('请选择已经讨论的方案');
  });
  it('does not turn an unverified delivery into a human testing assignment', () => {
    const value = recap(); value.summary.workState = 'needs_validation';
    expect(projectSignals(context([thread('a', { recap: value })]))).toMatchObject({ workState: 'needs_validation', actionRequired: false });
    expect(html([thread('a', { recap: value })])).not.toContain('<h3>明确待办</h3>');
  });
  it('preserves an older explicit recommended todo when a later recap has no next step', () => {
    const value = context([thread('a', { recap: recap() })]);
    value.todos = [{ todoKey: 'old-action', projectKey: 'test', sourceThreadKeys: ['a'], title: '核对上一份交付', minimumAction: '核对上一份交付', kind: 'review', strength: 'recommended', whyNow: '', unlocks: '', evidence: '明确交接，尚未解决', confidence: 'high', observedAt: time, lastObservedAt: time, missingSince: null, actionEvidence: { origin: 'explicit_handoff', sourceRefs: ['source'] } }];
    expect(projectSignals(value).actionRequired).toBe(true);
    expect(preview(value)).toMatchObject({action:'',summary:expect.stringContaining('完成合成模块'),source:expect.stringContaining('原始对话-a')});
    expect(historicalAction(projectActions(value)[0]!)).toBe(true);
    expect(renderToStaticMarkup(createElement(ProjectDetail, { context: value, focusedThreadKey: null, view: 'overview' }))).toContain('核对上一份交付');
    delete value.todos[0].actionEvidence;
    expect(projectSignals(value).actionRequired).toBe(false);
    expect(renderToStaticMarkup(createElement(ProjectDetail, { context: value, focusedThreadKey: null, view: 'overview' }))).not.toContain('核对上一份交付');
  });
  it('keeps a multi-source todo on its saved evidence when recap-local IDs collide or one source disappears', () => {
    const first = thread('first', { recap: recap() });
    const second = thread('second', { recap: recap() });
    second.recap!.sources[0]!.occurredAt = '2026-10-05';
    const ctx = context([first, second]);
    const savedAt = '2026-06-20';
    ctx.todos = [{todoKey:'paper',projectKey:'test',sourceThreadKeys:['first','second'],
      title:'核对纸重',minimumAction:'核对纸重',kind:'review',strength:'recommended',whyNow:'',unlocks:'',
      evidence:'合成快照保留的纸样记录',confidence:'high',observedAt:savedAt,lastObservedAt:savedAt,missingSince:null,
      actionEvidence:{origin:'explicit_handoff',sourceRefs:['source']}}];
    for (const missingSince of [null, time]) {
      first.missingSince = missingSince;
      const action = projectActions(ctx)[0]!;
      expect(action.sources.map(s => s.threadKey)).toEqual(missingSince ? ['second'] : ['first','second']);
      expect(actionEvidenceThread(action)).toBeUndefined();
      expect(actionRecordTime(action)).toBe(savedAt);
      const view = renderToStaticMarkup(createElement(ProjectDetail, {context:ctx,focusedThreadKey:null,view:'overview',onFocusThread(){}}));
      const row = view.slice(view.indexOf('核对纸重'));
      expect(row).toContain('记录于 ' + shortRecordDate(savedAt));
      expect(row).toContain('原始对话-second</button>');
      expect(row.includes('原始对话-first</button>')).toBe(!missingSince);
    }
    // Matching requires the saved key as well as one surviving source.
    const wrong = {...projectActions(ctx)[0]!,todo:{...ctx.todos[0]!,sourceThreadKeys:['first']}};
    expect(actionEvidenceThread(wrong)).toBeUndefined();
    expect(actionRecordTime(wrong)).toBe(savedAt);
    ctx.todos[0]!.sourceThreadKeys = ['second'];
    const exact = projectActions(ctx)[0]!;
    expect(actionEvidenceThread(exact)).toBe(second);
    expect(actionRecordTime(exact)).toBe('2026-10-05');
  });
  it('describes an external wait consistently without creating a human task', () => {
    const value = recap(); value.summary = {...value.summary,workState:'waiting_for_user',nextStepReason:'explicit',
      nextStep:{text:'等外部返回回执',kind:'wait',strength:'blocking',origin:'accepted_plan',sourceRefs:['source']}};
    const item = thread('outside',{recap:value}), ctx = context([item]);
    expect(projectSignals(ctx)).toMatchObject({workState:'waiting_external',actionRequired:false});
    expect(preview(ctx).action).toBe(''); expect(html([item])).not.toContain('<h3>明确待办</h3>');
    const detail = renderToStaticMarkup(createElement(ThreadSummary,{thread:item}));
    expect(detail).toContain('等待外部：'); expect(detail).not.toContain('明确待办：');
  });
  it('keeps independently dated progress and blocking tests on hover, without using a checks timestamp or runtime', () => {
    const old = recap(), newer = recap();
    old.summary.workState = 'needs_validation';
    old.summary.nextStep = {text:'测试横向导出',kind:'test',strength:'blocking',origin:'user_request',sourceRefs:['source']};
    old.summary.nextStepReason = 'explicit';
    old.evidenceCheckedAt = '2026-10-31T00:00:00Z';
    newer.summary.achievements[0] = {...newer.summary.achievements[0],title:'修复字符丢失',occurredAt:'2026-09-02T00:00:00Z'};
    const waiting = thread('验证',{recap:old,runtimeState:'running'});
    const ctx = context([waiting,thread('编辑器',{recap:newer})]);
    expect(projectReading(ctx).map(item => item.thread?.threadKey)).toEqual(['编辑器','验证']);
    expect(preview(ctx)).toMatchObject({summary:expect.stringContaining('修复字符丢失'),source:expect.stringContaining('原始对话-编辑器'),
      action:'测试横向导出',actionSource:'来自「原始对话-验证」'});
    expect(preview(context([waiting])).actionSource).toBeUndefined();
    const tooltip = renderToStaticMarkup(createElement(BubbleHoverPreview,{data:bubbleData(ctx),x:0,y:0}));
    const ordered = ['修复字符丢失','来自「原始对话-编辑器」','测试横向导出','来自「原始对话-验证」'].map(text => tooltip.indexOf(text));
    expect(ordered.every(i => i >= 0)).toBe(true);
    expect(ordered).toEqual([...ordered].sort((a,b) => a-b));
  });
  it('distinguishes a withdrawal and an open discussion from delivered versions and user assignments', () => {
    const value = recap();
    const event = {id:'version',kind:'version' as const,title:'撤回 2.0 运行验收',occurredAt:'2026-09-02',problem:null,options:[],decision:null,result:null,
      resolution:'withdrawn' as const,sourceRefs:['source'],version:{product:'排版器',number:'2.0',stage:'running' as const}};
    value.summary.milestones = [event];
    const source = thread('排版',{recap:value});
    expect(projectReading(context([source]))[0]).toMatchObject({label:'已撤回',text:expect.stringContaining('排版器 2.0')});
    expect(preview(context([source])).summary).not.toContain('运行已核验');
    expect(preview(context([source])).qualifier).toContain('已撤回');
    value.summary.milestones = [{...event,kind:'discussion',version:null,title:'纸面方案',problem:'该用哪种纸张？',resolution:'open'}];
    expect(projectReading(context([source]))[0]).toMatchObject({label:'讨论中',text:expect.stringContaining('哪种纸张')});
    expect(preview(context([source])).action).toBe('');
    value.summary.milestones[0]!.kind = 'decision';
    expect(projectReading(context([source]))[0]!.label).toBe('开放问题');
  });
  it('retains file evidence inside source details and never offers to read it as a conversation turn', () => {
    const r = recap();
    r.sources = [{id:'private-file-ref',role:'file',occurredAt:time,turnId:null,path:'synthetic/proof.md'}];
    r.summary.achievements[0]!.sourceRefs = ['private-file-ref'];
    r.summary.stopPointRefs = ['private-file-ref'];
    const ctx = context([thread('file',{recap:r})]);
    const overview = renderToStaticMarkup(createElement(ProjectDetail,{context:ctx,focusedThreadKey:null,view:'overview',canReadSource:true}));
    expect(overview).toContain('展开引用记录'); expect(overview).not.toMatch(/synthetic\/proof.md|private-file-ref|查看原文/);
    const detail = renderToStaticMarkup(createElement(ThreadSummary,{project:ctx.project,thread:ctx.threads[0]!,canReadSource:true}));
    expect(detail).toContain('文件记录'); expect(detail).toContain('synthetic/proof.md'); expect(detail).toContain('复制引用');
    expect(detail).not.toMatch(/private-file-ref|查看原文/);
  });
  it('deduplicates identical progress and keeps the two newest independent work lines', () => {
    const original = thread('A',{recap:recap()});
    const duplicate = thread('B',{recap:recap()});
    const third = thread('C',{stopPoint:'独立封面样稿已交付',sourceUpdatedAt:'2026-08-30'});
    const fourth = thread('D',{stopPoint:'更早的画稿',sourceUpdatedAt:'2026-08-20'});
    expect(projectReading(context([original,duplicate,third,fourth])).map(item => item.thread?.threadKey)).toEqual(['A','C']);
    duplicate.recap!.sources[0]!.turnId = '不同的交付';
    expect(projectReading(context([original,duplicate,third])).map(item => item.thread?.threadKey)).toEqual(['A','B']);
  });
  it('keeps a documented version above newer generic chat even when the old project brief repeats it', () => {
    const answers = ['好的。','讨论了下一步。','已完成相关优化。','已讨论相关内容，暂无明确下一步。'];
    const chatter = answers.map((stopPoint,index) => {
      const r = recap();
      r.summary = {...r.summary, stopPoint, achievements:[],versions:[]};
      r.sources[0]!.occurredAt = '2026-10-01'; r.evidenceCheckedAt = '2026-10-02';
      return thread('交流'+index,{recap:r,sourceUpdatedAt:'2026-10-01'});
    });
    const saved = thread('构建',{recap:recap()});
    const legacy = thread('复核',{stopPoint:'装订孔测量偏差已校正',sourceUpdatedAt:'2026-10-01'});
    const latest = projectReading(context([...chatter, legacy, saved]));
    expect(latest.map(item => item.thread?.threadKey)).toEqual(['构建','复核']);
    expect(latest[0]?.occurredAt).toBe(time);
    const only = context(chatter);
    only.brief = {projectKey:'test',overview:'',currentStage:'',workState:'in_progress',codexOrExternalNext:'',stopPoint:chatter.map(t => t.title+'：'+t.recap!.summary.stopPoint).join('\n'),
      evidenceLevel:'deep_read',evidenceReason:'合成',confidence:'high',observedAt:time,lastObservedAt:time,missingSince:null};
    expect(projectReading(only)).toEqual([]);
    expect(renderToStaticMarkup(createElement(BubbleHoverPreview,{data:bubbleData(only),x:0,y:0}))).toBe('');
    const actionOnly = recap();
    actionOnly.summary = {...actionOnly.summary,achievements:[],versions:[],stopPoint:'请确认纸张',workState:'waiting_for_user',
      nextStepReason:'explicit',nextStep:{kind:'decide',strength:'blocking',text:'请确认纸张',origin:'explicit_handoff',sourceRefs:['source']}};
    const pending = {...context([thread('确认',{recap:actionOnly})]),brief:{...only.brief,stopPoint:'确认：请确认纸张'}};
    expect(projectReading(pending)).toEqual([]);
    expect(preview(pending).action).toBe('请确认纸张');
    expect(preview(pending).summary).toBe('');
    expect(projectReading(context([thread('t',{stopPoint:'最新版已发布',evidence:''})]))).toEqual([]);
    for (const text of ['已发现此对话，尚未取得可追溯的总结；不代表没有进展。',
      'App Server can identify this task, but a semantic progress snapshot has not been imported yet.'])
      expect(projectReading(context([thread('索引',{stopPoint:text,evidence:'thread/list'})]))).toEqual([]);
    const invalid = recap(); invalid.sources = [];
    expect(projectReading(context([thread('丢失证据',{recap:invalid})]))).toEqual([]);
  });
  it('suppresses an older exact release-stage claim even after the withdrawing thread has newer unrelated work', () => {
    const old = recap(), correction = recap();
    const deployed = {id:'release',kind:'version' as const,title:'2.0 运行验收',occurredAt:'2026-09-01',problem:null,options:[],decision:null,result:'已验收',
      resolution:'verified' as const,sourceRefs:['source'],version:{product:'图集',number:'2.0',stage:'running' as const}};
    old.summary.milestones = [deployed];
    old.summary.achievements = []; old.summary.versions = [];
    correction.summary.milestones = [{...deployed,occurredAt:'2026-09-02',resolution:'withdrawn',result:null},
      {...deployed,id:'notes',kind:'decision',title:'装订选型',occurredAt:'2026-09-03',resolution:'decided',decision:'采用锁线装订',result:null,version:null}];
    const other = recap(); other.summary.milestones = [{...deployed,version:{...deployed.version,product:'影集'}}];
    const result = projectReading(context([thread('旧验收',{recap:old}),thread('更正',{recap:correction}),thread('另一产品',{recap:other})]));
    expect(result.map(line => line.thread?.threadKey)).toEqual(['更正','另一产品']);
    expect(result[0]?.text).toContain('采用锁线装订'); expect(result[1]?.text).toContain('影集');
  });
  it('separates partially overlapping citations and distinguishes an event date from the date it was mentioned', () => {
    const r = recap();
    r.sources[0]!.occurredAt = '2026-02-10'; r.sources.push({...r.sources[0]!,id:'new',occurredAt:'2026-04-10'});
    const discussion = {id:'layout',kind:'discussion' as const,title:'讨论边距',occurredAt:null,problem:'边距多大合适？',options:[],decision:null,result:null,
      resolution:'open' as const,sourceRefs:['source'],version:null};
    r.summary.milestones = [discussion];
    r.summary.achievements = [{...r.summary.achievements[0]!,title:'样书完成装订',sourceRefs:['source','new'],occurredAt:'2026-04-03'}];
    r.summary.stopPointRefs = ['source','new'];
    r.summary.versions = [{version:'3.0',stage:'source',sourceRefs:['source']}];
    const ctx = context([thread('打样',{recap:r})]);
    expect(projectReading(ctx)[0]).toMatchObject({label:'成果',text:'样书完成装订',occurredAt:'2026-04-03',timeKind:'event'});
    r.summary.achievements = []; r.summary.versions = [];
    r.summary.stopPoint = '样书已完成装订。';
    expect(projectReading(ctx)[0]).toMatchObject({label:'对话停点',text:'样书已完成装订。',timeKind:'source',occurredAt:'2026-04-10'});
    r.summary.stopPoint = '好的。';
    expect(projectReading(ctx)[0]).toMatchObject({label:'讨论中',timeKind:'source',occurredAt:'2026-02-10'});
    expect(preview(ctx).source).toContain('记录于'); expect(preview(ctx).source).not.toContain('发生于');
  });
  it('allows a newer concrete stopping point in the same thread without displacing a separate documented work line', () => {
    const r = recap(); r.summary.achievements = []; r.summary.versions = [];
    r.sources[0]!.occurredAt = '2026-02-10'; r.sources.push({...r.sources[0]!,id:'april',occurredAt:'2026-04-10'});
    r.summary.milestones = [{id:'proof',kind:'version',title:'合成打样 1.2',occurredAt:'2026-02-06',problem:null,options:[],decision:null,result:'便携包生成',
      resolution:'delivered',sourceRefs:['source'],version:{product:'合成打样',number:'1.2',stage:'built'}}];
    const line = thread('打样',{recap:r});
    r.summary.stopPoint = '已讨论相关内容，暂无明确下一步。'; r.summary.stopPointRefs = ['april'];
    expect(projectReading(context([line]))[0]).toMatchObject({label:'版本记录',text:expect.stringContaining('已构建')});
    r.summary.stopPoint = '输出卡在第四页的裁切偏移校准。';
    expect(projectReading(context([line]))[0]).toMatchObject({text:r.summary.stopPoint,timeKind:'source',occurredAt:'2026-04-10'});
    const independent = recap();
    independent.sources[0]!.occurredAt = '2026-03-05'; independent.summary.achievements[0]!.occurredAt = '2026-03-05';
    expect(projectReading(context([line,thread('独立编排',{recap:independent})])).map(item => item.thread?.threadKey)).toEqual(['独立编排','打样']);
  });
  it('retires only the attributed action and never reuses another line with the same task wording', () => {
    const a = recap(), b = recap();
    a.summary.resolvedTodos = [{todoKey:'a-todo',sourceRefs:['source']},{todoKey:'b-todo',sourceRefs:['source']}];
    const ctx = context([thread('a',{recap:a}),thread('b',{recap:b})]);
    const base = {projectKey:'test',title:'核对样稿',minimumAction:'核对样稿',evidence:'明确交接',whyNow:'',unlocks:'',
      kind:'review' as const,strength:'blocking' as const,confidence:'high' as const,observedAt:time,lastObservedAt:time,missingSince:null};
    ctx.todos = ['a','b'].map(key => ({...base,todoKey:key+'-todo',sourceThreadKeys:[key]}));
    ctx.todos.push({...base,todoKey:'archived',sourceThreadKeys:['b'],missingSince:time});
    expect(projectActions(ctx).map(action => action.todo?.todoKey)).toEqual(['b-todo']);
    expect(awaitsResponse(projectActions(ctx)[0]!)).toBe(false);
  });
  it('never renders executable, protocol relative or network-share artifact links', () => {
    for (const uri of ['javascript:alert(1)', 'data:text/html,bad', '//host/file', '\\\\host\\file', 'file:///E:/test', 'https://name:secret@example.com']) expect(artifactTarget(uri)).toBe('blocked');
    expect(artifactTarget('https://example.com/report')).toBe('web'); expect(artifactTarget('E:\\fixture\\a.md')).toBe('local'); expect(artifactTarget('/fixture/a.md')).toBe('local');
    const value = recap(); value.summary.artifacts[0].uri = 'javascript:alert(1)';
    const text = renderToStaticMarkup(createElement(ThreadSummary,{thread:thread('a', {recap:value})}));
    expect(text).not.toContain('href="javascript:'); expect(text).toContain('不支持打开此产物地址');
  });
});

describe('summary job presentation', () => {
  it('offers only exact present model and effort pairs, without selecting one during render', () => {
    const chosen: string[] = [];
    const text = renderToStaticMarkup(createElement(ProjectModelChoices,{catalog:[
      {id:'gpt-6.2-sol',efforts:['medium','high']},{id:'gpt-6.1-terra',efforts:['high']},{id:'terra62sol',efforts:['medium']}],onSelect:s=>chosen.push(s.model)}));
    expect(text).toContain('gpt-6.2-sol'); expect(text).not.toMatch(/gpt-6\.1-terra|terra62sol/); expect(chosen).toEqual([]);
    expect(renderToStaticMarkup(createElement(ProjectModelChoices,{catalog:[],onSelect:()=>{}}))).toBe('');
  });
  it('does not represent unknown usage as zero and labels non-additive details', () => {
    expect(renderToStaticMarkup(createElement(UsageSummary, { job: { usage: null } }))).toContain('未知');
    const text = renderToStaticMarkup(createElement(UsageSummary, { job: { usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20, reasoningOutputTokens: 10, totalTokens: 120 } } }));
    expect(text).toContain('120 token'); expect(text).toContain('不再次相加');
  });
  it('shows partial source coverage and cannot resume a cleaned evidence job', () => {
    const job: SyncJob = { id: 'test', state: 'paused', createdAt: time, updatedAt: time, completed: 1, total: 2, skipped: 0, error: null, usage: null, model: 'model', effort: 'medium', coverage: { projectsFound: 2, threadsFound: 3, deepRead: 2, fileChecked: 0, truncated: true, inaccessible: ['远程不可访问'] }, needsResubmit: true };
    const text = renderToStaticMarkup(createElement(SyncJobCard, { job, online: true, busy: false, onAction: () => {} }));
    expect(text).toContain('覆盖不完整'); expect(text).toContain('远程不可访问'); expect(text).toContain('再次检查项目即可重试'); expect(text).not.toContain('>继续</button>');
    expect(text.indexOf('本次更新详情')).toBeLessThan(text.indexOf('model')); expect(text).not.toContain('<details open');
  });
});
