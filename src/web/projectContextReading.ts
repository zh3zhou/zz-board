import type { BoardThread, ThreadRecap } from '../shared/schema.js';
import type { Milestone } from '../shared/milestones.js';
import { recapNeedsUpdate } from '../shared/projectProgress.js';
import type { ProjectBubbleContext } from './projectCanvas.js';

export interface ProjectReadingItem {
  text: string;
  label: string;
  occurredAt?: string;
  thread?: BoardThread;
  sourceRefs: string[];
  historical: boolean;
  reported?: boolean;
  timeKind?: 'event' | 'source' | 'activity';
  versionKey?: string;
}

export const versionLabels = { source: '源码已实现', built: '包已构建', running: '运行已核验' };
const validDate = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? value : undefined;
const time = (item: ProjectReadingItem) => Date.parse(item.occurredAt ?? '') || 0;

/** Keep a date-only event on its recorded day; instants use the reader's local calendar. */
export function shortRecordDate(value?: string | null, today = new Date()): string {
  if (!value || !validDate(value)) return '';
  const at = new Date(value);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const year = dateOnly ? at.getUTCFullYear() : at.getFullYear();
  const month = 1 + (dateOnly ? at.getUTCMonth() : at.getMonth());
  const day = dateOnly ? at.getUTCDate() : at.getDate();
  return `${year !== today.getFullYear() ? year + ' 年 ' : ''}${month} 月 ${day} 日`;
}

export function readingDate(line: ProjectReadingItem): string {
  const day = shortRecordDate(line.occurredAt);
  const date = day && (line.timeKind === 'source' ? '记录于 ' + day : line.timeKind === 'activity' ? '对话更新于 ' + day : day);
  return [date, line.reported && '据助手记录'].filter(Boolean).join(' · ');
}

export function readingQualifier(line: ProjectReadingItem): string {
  const meaning = ['已撤回', '讨论中', '开放问题', '已决定'].includes(line.label) ? line.label : '';
  const thread = line.thread;
  const freshness = thread?.missingSince ? '上次记录，本次未读到对话' : thread && recapNeedsUpdate(thread) ? '摘要待更新' : '';
  const validation = thread && (thread.recap?.summary.workState ?? thread.workState) === 'needs_validation' ? '对话待验证' : '';
  return [meaning, freshness, validation].filter(Boolean).join(' · ');
}

// Legacy stop points can be a conversational acknowledgement. Discard only
// complete stock clauses; a sentence naming a concrete subject survives intact.
const acknowledgements = /^(?:好的?|知道了|收到了?|明白了?|谢谢|已阅|可以|继续|ok(?:ay)?|thanks?|证据不足|交流收尾)$/iu;
const unspecified = /^(?:暂时?|尚)?(?:无|没有|未)(?:提供|提出|记录|看到)?(?:明确的?)?(?:下一步|后续动作|成果|进展|交付记录)$/u;
const routineUpdate = /^(?:讨论|沟通|交流|完成|进行|优化)了?(?:相关|一些|本轮|本次|后续的?|接下来的?)?(?:内容|事宜|事项|工作|交流|讨论|问题|优化|改进|调整|下一步|后续|后续计划)$/u;
const metadataOnly = [
  '已发现此对话，尚未取得可追溯的总结', '尚未生成近况', '未知：没有关联任务可以证明', '未知：代表任务没有停点说明',
  'App Server can identify this task, but a semantic progress snapshot has not been imported yet.'
];
function hasSubject(text: string): boolean {
  if (metadataOnly.some(placeholder => text.trim().startsWith(placeholder))) return false;
  return text.split(/[，。；！？,;!?·\n]/u).some(part => {
    const clause = part.trim().replace(/[.]+$/u, '');
    const clauseBody = clause.replace(/^(?:本轮|本次|目前|已经|已|双方|我们)+/u, '');
    return clause && !acknowledgements.test(clause) && !unspecified.test(clause) && !routineUpdate.test(clauseBody);
  });
}

// Keep the saved words, including failures and test conditions. Only complete
// clauses that describe routine bookkeeping are elided from the compact view.
const reportingLead = /^助手(?:报告|汇报)(?:(?:称|说)[：:，,\s]*|[：:，,\s]+|(?=(?:修复|解决|新增|完成|交付|相关(?:修复|优化|改进)|(?:工程)?候选版)))/u;
const boundary = /(?:仅|只|除非|如果|若|尚|仍|未|不|无法|待(?:验|测)|失败|异常|受限|超时|回退|撤回|至少|至多|最多|最低|最高)/u;
const genericTestCount = /^(?:共|合计)?\s*\d+\s*(?:项|个|条|组)\s*(?:自动化?|单元|集成|回归|端到端|常规|核心)?$/u;
const platformTestCount = /^\d+\s*(?:项|个|条|组)\s*(?:Windows|macOS|Linux|Android|iOS)$/iu;
const administration = /^(?:(?:[\d一二两三四五六七八九十]+\s*(?:名|位|轮|次)\s*)?(?:独立)?(?:复核|审查|评审)(?:(?:及|和|与)(?:启动|关闭|退出){1,2}检查)?(?:已)?(?:闭环|通过|完成)|(?:已)?(?:完成)?相关(?:修复|优化|改进)(?:(?:与|和|及)文档交付)?|(?:已)?(?:更新|交付)(?:相关|配套)文档)$/u;
const deliveryHeading = /^(?:工程)?(?:候选版|预览版|试用版|构建产物)?(?:交付|构建)(?:与|及|和)(?:自动)?(?:验证|审查|测试)$/u;

function isTestTally(clause: string): boolean {
  const counted = /^(.+?)(?:测试|用例|校验)(?:均|全部)?已?(?:通过|成功)$/u.exec(clause)?.[1];
  if (!counted) return false;
  const groups = counted.trim().split(/\s*、\s*/u);
  // A lone platform result is specific. A breakdown of one suite by platform is a tally.
  return groups.every(group => genericTestCount.test(group) || groups.length > 1 && platformTestCount.test(group));
}

function excerpt(value: string): string {
  const text = value.trim().replace(reportingLead, '');
  if (!hasSubject(text)) return '';
  const sentences = text.match(/[^。；！？;!?\n]+[。；！？;!?\n]*/gu) ?? [];
  let passedTests = false;
  const clean = sentences.map(sentence => {
    if (!hasSubject(sentence)) return '';
    if (boundary.test(sentence)) return sentence;
    const end = sentence.match(/[。；！？;!?\n]+$/u)?.[0] ?? '';
    const body = sentence.slice(0, sentence.length - end.length);
    const kept = (body.match(/[^，,]+[，,]*/gu) ?? []).filter(fragment => {
      const clause = fragment.replace(/[，,]+$/u, '').trim();
      // Counts about a named feature, platform or condition can explain precisely what was tested.
      if (isTestTally(clause)) {
        passedTests = true;
        return false;
      }
      return hasSubject(clause) && !administration.test(clause);
    }).join('').trim().replace(/[，,]+$/u, '');
    return kept && kept + end;
  }).join('').trim().replace(/[，,；;]+$/u, '');
  return clean || (passedTests ? '已有测试通过。' : '');
}

function factText(title: string, detail?: string | null): string {
  const heading = excerpt(title), body = detail ? excerpt(detail) : '';
  if (!body) return deliveryHeading.test(heading) ? '' : heading;
  if (!heading || deliveryHeading.test(heading) || body.includes(heading)) return body;
  const edition = /^交付(?:了)?(?:可[\p{Script=Han}]{1,16}的)?(?:工程)?(候选版|预览版|试用版)$/u.exec(heading)?.[1];
  if (edition && /^(?:已)?(?:修复|解决|新增|支持|保留)/u.test(body)) return edition + body;
  return heading + '，' + body;
}

// A compact selection from a homogeneous list ("修复 A、B、C 和 D 问题").
// Never abbreviate conditions, named versions, measured values or failures.
function shortIssueList(text: string): string {
  return text.replace(/^(候选版|试用版|预览版)?(修复|解决)了?([\p{Script=Han}]{2,12})、([\p{Script=Han}]{2,12}(?:、[\p{Script=Han}]{2,12})*)(?:和|以及)([\p{Script=Han}]{2,12})问题/u,
    (whole, edition: string | undefined, verb: string, first: string, middle: string, last: string) =>
      boundary.test(first + last) || /(?:仅|只|若|未|仍|不|导致|之前|之后|依赖)/u.test(middle)
        ? whole : `${edition ?? ''}${verb}了${first}和${last}等问题`);
}

export function sourceEventTime(recap: ThreadRecap, refs: string[]): string | undefined {
  return recap.sources.filter(source => refs.includes(source.id) && validDate(source.occurredAt))
    .sort((a,b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0]?.occurredAt;
}

function eventLabel(event: Milestone): string {
  if (event.resolution === 'withdrawn') return '已撤回';
  if (event.resolution === 'open') return event.kind === 'discussion' ? '讨论中' : '开放问题';
  if (event.resolution === 'decided') return '已决定';
  if (event.kind === 'version' && event.resolution === 'delivered') return '版本记录';
  return event.resolution === 'verified' ? '已核验' : '已交付';
}

function eventText(event: Milestone): string {
  const subject = event.version ? [event.version.product, event.version.number].filter(Boolean).join(' ') : event.title;
  const stage = event.version && (event.resolution === 'delivered' || event.resolution === 'verified'
    ? { source: '源码已实现', built: '已构建', running: '运行已核验' }[event.version.stage]
    : {source: '源码阶段', built: '构建阶段', running: '运行验收阶段'}[event.version.stage]);
  const content = event.resolution === 'withdrawn' ? event.title : event.resolution === 'open' ? event.problem :
    event.resolution === 'decided' ? event.decision : event.result;
  const lead = stage ? `${subject} ${stage}` : subject;
  return factText(lead, content);
}

function milestoneKey(event: Milestone, thread: BoardThread): string {
  const version = event.version;
  return version ? JSON.stringify(['version', version.product ?? ['thread', thread.threadKey], version.number, version.stage]) :
    JSON.stringify(['event', thread.threadKey, event.id]);
}

function sameRefs(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(ref => right.includes(ref));
}

const isResult = (label: string) => ['成果','已核验','已交付','版本记录'].includes(label);

function recordedTestHandoff(recap: ThreadRecap, item: ProjectReadingItem): string {
  const { nextStep, stopPoint, stopPointRefs } = recap.summary;
  if (!nextStep || nextStep.kind !== 'test' || nextStep.origin !== 'explicit_handoff' || nextStep.strength !== 'recommended' ||
      item.sourceRefs.length !== 1 || !sameRefs(item.sourceRefs, nextStep.sourceRefs) || !sameRefs(item.sourceRefs, stopPointRefs) ||
      !/(?:实(?:机|体).{0,8}(?:未|待)|(?:待|还需|尚需).{0,4}(?:实测|验收)|交接清单.{0,8}(?:验|测))/u.test(stopPoint)) return '';
  const sourceDay = shortRecordDate(sourceEventTime(recap, item.sourceRefs));
  if (!sourceDay || sourceDay !== shortRecordDate(item.occurredAt)) return '';
  const original = nextStep.text.trim().replace(/[。]$/u, '');
  if (!original || item.text.includes(original)) return '';
  const checks = /^(?:按(?:照)?交接清单)?(?:集中)?(?:实测|测试|验证)[：:\s]*(.+)$/u.exec(original)?.[1];
  // Only take a self-contained example from an explicitly coordinated list.
  // Keep any scope, ordering, named device/version or numerical constraint verbatim.
  if (checks && !boundary.test(checks) && !/[\d%％在前后需再]/u.test(checks)) {
    const example = /^[^，。；]+、[^，。；]+，以及(恢复[\p{Script=Han}]{2,24})$/u.exec(checks)?.[1];
    if (example) return '当时还要实测能否' + example + '。';
  }
  return '当时的交接也提到“' + original + '”。';
}

function hasReferences(recap: ThreadRecap, refs: string[]): boolean {
  return refs.length > 0 && refs.every(ref => recap.sources.some(source => source.id === ref));
}

function readingIdentity(line: ProjectReadingItem): string {
  if (line.versionKey) return line.versionKey;
  const thread = line.thread;
  const sources = thread?.recap?.sources.filter(source => line.sourceRefs.includes(source.id));
  const locations = sources?.map(source => JSON.stringify(
    [thread?.hostId, thread?.sourceKind, source.path, source.turnId, source.role, source.occurredAt, source.id]
  )).sort();
  return JSON.stringify([line.label, line.text.replace(/\s+/gu, ' ').trim(), locations?.length ? locations : thread?.threadKey]);
}

function workLine(thread: BoardThread, withdrawals: Map<string, number>): ProjectReadingItem | undefined {
  const recap = thread.recap;
  const historical = Boolean(thread.missingSince || recapNeedsUpdate(thread));
  if (!recap) {
    const text = excerpt(thread.stopPoint);
    return text && thread.evidence.trim() ? { thread, label: '对话停点', text, reported: reportingLead.test(thread.stopPoint), sourceRefs: [],
      occurredAt: validDate(thread.sourceUpdatedAt), timeKind:'activity', historical } : undefined;
  }
  const {summary} = recap;
  const candidates: ProjectReadingItem[] = [];
  const add = (text: string, label: string, refs: string[], at?: string | null, versionKey?: string, reported = false) => {
    if (!hasReferences(recap, refs) || !hasSubject(text)) return;
    const eventAt = validDate(at);
    candidates.push({thread, text: isResult(label) ? shortIssueList(text) : text, label, reported, sourceRefs: refs, occurredAt: eventAt ?? sourceEventTime(recap, refs),
      timeKind:eventAt ? 'event' : 'source', historical, versionKey});
  };
  // Typed milestones distinguish an open question or a withdrawal from a delivery. Older
  // recap formats may record different events in an achievement and a version from the same turn.
  const milestones = summary.milestones ?? [];
  const retracted: Milestone[] = [];
  for (const event of milestones) {
    const key = milestoneKey(event, thread);
    const withdrawn = withdrawals.get(key);
    const at = validDate(event.occurredAt) ?? sourceEventTime(recap, event.sourceRefs);
    if (event.resolution !== 'withdrawn' && withdrawn !== undefined && (!at || withdrawn >= Date.parse(at))) {
      retracted.push(event);
      continue;
    }
    add(eventText(event), eventLabel(event), event.sourceRefs, event.occurredAt, event.version ? key : undefined,
      reportingLead.test(event.result ?? event.decision ?? event.problem ?? event.title));
  }
  for (const item of summary.achievements) {
    if (milestones.some(event => sameRefs(event.sourceRefs, item.sourceRefs) &&
      (item.title === event.title || Boolean(item.detail && item.detail === event.result)))) continue;
    const detail = item.detail && item.detail !== item.title ? item.detail : '';
    add(factText(item.title, detail), '成果', item.sourceRefs, item.occurredAt, undefined, reportingLead.test(detail));
  }
  for (const version of summary.versions) {
    if (milestones.some(event => sameRefs(event.sourceRefs, version.sourceRefs) &&
      event.version?.number === version.version && event.version.stage === version.stage)) continue;
    add(`${version.version} · ${versionLabels[version.stage]}`, '版本', version.sourceRefs);
  }
  const stopTime = sourceEventTime(recap, summary.stopPointRefs);
  const newStopEvidence = stopTime && candidates.every(item => Date.parse(stopTime) > time(item)) &&
    summary.stopPointRefs.some(ref => candidates.every(item => !item.sourceRefs.includes(ref)));
  if ((!candidates.length || newStopEvidence) && summary.stopPoint !== summary.nextStep?.text &&
      !retracted.some(event => sameRefs(event.sourceRefs, summary.stopPointRefs)))
    add(excerpt(summary.stopPoint), '对话停点', summary.stopPointRefs, undefined, undefined, reportingLead.test(summary.stopPoint));
  // At the same source time a withdrawal overrides a recorded success. Stable sorting
  // otherwise preserves structured events before their less descriptive representations.
  const proofOnly = (item: ProjectReadingItem) => /(?:已有测试通过|(?:已|通过)(?:自动)?(?:验证|测试)|(?:审核|审查)完成)[。.]?$/u.test(item.text) &&
    !boundary.test(item.text) && !/(修复|解决|新增|支持|实测从|降至)/u.test(item.text);
  const best = candidates.sort((a,b) => time(b) - time(a) || Number(b.label === '已撤回') - Number(a.label === '已撤回') ||
    Number(proofOnly(a)) - Number(proofOnly(b)))[0];
  if (best && isResult(best.label)) {
    const handoff = recordedTestHandoff(recap, best);
    if (handoff) return {...best,text:best.text.replace(/[。.]?$/u, '。') + handoff};
  }
  return best;
}

export function projectReading(context: Pick<ProjectBubbleContext, 'threads' | 'brief'>): ProjectReadingItem[] {
  const withdrawals = new Map<string, number>();
  for (const thread of context.threads) {
    const recap = thread.recap;
    if (!recap || thread.missingSince) continue;
    for (const event of recap.summary.milestones ?? []) {
      if (event.resolution !== 'withdrawn' || !hasReferences(recap, event.sourceRefs)) continue;
      const key = milestoneKey(event, thread);
      const at = validDate(event.occurredAt) ?? sourceEventTime(recap, event.sourceRefs);
      if (at) withdrawals.set(key, Math.max(withdrawals.get(key) ?? -Infinity, Date.parse(at)));
    }
  }
  const lines = context.threads.flatMap(thread => workLine(thread, withdrawals) ?? []);
  const current = lines.filter(line => !line.historical);
  const ranked = (current.length ? current : lines).sort((a,b) =>
    Number(a.label === '对话停点') - Number(b.label === '对话停点') ||
    time(b) - time(a) || Number(b.label === '已撤回') - Number(a.label === '已撤回'));
  const seen = new Set<string>();
  const result = ranked.filter(line => {
    const key = readingIdentity(line);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 2);
  if (result.length) return result;
  const brief = context.brief;
  if (!brief || brief.missingSince || brief.evidenceLevel === 'none' || context.threads.some(t => t.recap)) return [];
  // Some historical briefs are a concatenation of thread titles and stop points;
  // a descriptive title alone does not turn an acknowledgement into new progress.
  const useful = brief.stopPoint.split('\n').filter(line => {
    const source = context.threads.find(thread => line.startsWith(thread.title + '：'));
    return (!source || Boolean(source.evidence.trim())) && hasSubject(source ? line.slice(source.title.length + 1) : line);
  });
  return useful.length ? [{text: useful.join('\n'), label: '旧项目简报', occurredAt: validDate(brief.lastMeaningfulAt), timeKind:'source', sourceRefs: [], historical: true}] : [];
}
