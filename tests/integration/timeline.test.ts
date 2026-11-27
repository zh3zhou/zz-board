import { afterEach, describe, expect, it } from 'vitest';
import { BoardDatabase } from '../../src/server/database.js';
import { SummaryJobs, sourceFingerprint, validateMilestoneEvidence } from '../../src/server/summaryJobs.js';
import { DEFAULT_SUMMARY_SETTINGS } from '../../src/shared/summarySync.js';
import type { ThreadRecap } from '../../src/shared/schema.js';
import type { Milestone } from '../../src/shared/milestones.js';
import { createDemoSnapshot } from '../../src/shared/demo.js';
import { bundle, source, summary, time } from '../fixtures/summary.js';
import { grantSyntheticCodexAccess } from '../fixtures/codexAccess.js';

const opened: BoardDatabase[] = []; const queues: SummaryJobs[] = [];
const database = () => { const db = new BoardDatabase(':memory:'); grantSyntheticCodexAccess(db); opened.push(db); return db; };
afterEach(() => { queues.forEach(queue => queue.dispose()); opened.forEach(db => db.close()); queues.length = opened.length = 0; });
const settle = async (jobs: SummaryJobs) => { for (let i = 0; i < 100; i++) { if (jobs.list().every(job => !['queued', 'running'].includes(job.state))) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Not settled'); };
function milestone(patch: Partial<Milestone> = {}): Milestone { return { id: 'decision', kind: 'discussion', title: '存储方案', occurredAt: time, problem: '如何保存资料', options: ['本地文件', '数据库'], decision: null, result: null, resolution: 'open', sourceRefs: ['a:result'], version: null, ...patch }; }
function save(db: BoardDatabase, values: Milestone[], version = 0) {
  const input = source(); input.sourceUpdatedAt = new Date(Date.parse(time) + version * 1000).toISOString();
  input.evidence[0]!.text += ` 修订 ${version}`;
  const fingerprint = sourceFingerprint(input); db.prepareEvidence(bundle([input]), new Map([[input.threadKey, fingerprint]]));
  const recap: ThreadRecap = { summary: { ...summary(), achievements: [], versions: [], milestones: values }, sources: input.evidence.map(({ text: _text, ...value }) => value),
    sourceFingerprint: fingerprint, evidenceCheckedAt: time, summarizedAt: time, model: 'test', effort: 'medium', promptVersion: 'project-recap-4' };
  expect(db.commitRecap(input, recap)).toBe(true);
}
describe('durable project milestones', () => {
  it('retains more than twelve version stages without changing notes or undo', () => {
    const db = database(); const note = db.createNote({ title: '', body: '保留\n  中文', x: 2, y: 3, width: 180, height: 120 }); const history = db.getHistoryStatus();
    for (let version = 0; version < 7; version++) save(db, (['source', 'built', 'running'] as const).map(stage => milestone({ id: `${version}-${stage}`, kind: 'version', title: `1.${version}`, version: { product: '合成程序', number: `1.${version}`, stage }, resolution: 'delivered', result: '合成成果' })), version);
    expect(db.timeline.page('example', 0, 50).total).toBe(7); expect(db.timeline.page('example', 0, 50).items).toHaveLength(21);
    expect(db.timeline.page('example', 0, 1).items).toHaveLength(3); expect(db.timeline.page('example', 0, 1).nextOffset).toBe(1);
    const firstPage = db.timeline.page('example', 0, 1);
    db.timeline.markRead('example', firstPage.throughSequence, firstPage.items.map(item => item.key));
    expect(db.timeline.page('example', 1, 1).items.every(item => item.unread)).toBe(true);
    expect(db.timeline.page('example').unread).toBe(18);
    expect(db.getHistoryStatus()).toEqual(history); expect(db.getBoard().nodes.find(value => value.id === note.id)).toEqual(note);
    db.undo(); expect(db.getBoard().nodes.some(value => value.id === note.id)).toBe(false); expect(db.timeline.page('example').total).toBe(7);
    db.redo(); expect(db.getBoard().nodes.some(value => value.id === note.id)).toBe(true);
  });
  it('retains omitted events, meaningful revisions, unknown dates and read races', () => {
    const db = database(); save(db, [milestone({ occurredAt: null })]); const first = db.timeline.page('example');
    db.timeline.markRead('example', first.throughSequence, first.items.map(item => item.key)); save(db, [milestone({ occurredAt: null })], 1);
    expect(db.timeline.page('example')).toMatchObject({ total: 1, unread: 0 });
    save(db, [milestone({ kind: 'decision', occurredAt: null, decision: '选用本地文件', resolution: 'decided' })], 2);
    db.timeline.markRead('example', first.throughSequence, first.items.map(item => item.key)); expect(db.timeline.page('example').unread).toBe(1);
    expect(db.timeline.revisions(first.items[0]!.key)).toHaveLength(2); save(db, [], 3);
    expect(db.timeline.page('example').items[0]!.value).toMatchObject({ occurredAt: null, decision: '选用本地文件' });
    db.importSnapshot(createDemoSnapshot()); expect(db.timeline.page('example').total).toBe(1);
  });
  it('does not merge same titles across sources or version numbers across products', () => {
    const db = database(); save(db, [milestone()]);
    const old = db.timeline.page('example').items[0]!;
    db.timeline.record({ ...old, sourceKey: 'another', sourceLabel: '另一条对话' }, [milestone()], old.sources);
    for (const product of ['甲', '乙']) db.timeline.record(old, [milestone({ id: product, kind: 'version', result: '已构建', resolution: 'delivered', version: { product, number: '1', stage: 'built' } })], old.sources);
    expect(db.timeline.page('example').total).toBe(4);
  });
  it('upgrades legacy fingerprint caches with zero calls and keeps summary time', async () => {
    const db = database(); const input = source(); const fingerprint = sourceFingerprint(input, 'project-recap-3');
    db.prepareEvidence(bundle(), new Map([[input.threadKey, fingerprint]]));
    db.commitRecap(input, { summary: summary(), sources: input.evidence.map(({ text: _text, ...e }) => e), sourceFingerprint: fingerprint, evidenceCheckedAt: time,
      summarizedAt: time, promptVersion: 'project-recap-3', model: 'gpt-5.6-sol', effort: 'medium' });
    let calls = 0; const jobs = new SummaryJobs(db, { summarize: async () => { calls++; return { value: summary(), usage: null, model: 'test' }; } }); queues.push(jobs);
    expect(jobs.create(bundle(), DEFAULT_SUMMARY_SETTINGS)).toMatchObject({ skipped: 1, total: 0 }); expect(calls).toBe(0);
    expect(db.getBoard().threads[0]!.recap).toMatchObject({ sourceFingerprint: sourceFingerprint(input), summarizedAt: time, model: 'gpt-5.6-sol' });
    expect(jobs.create(bundle(), { model: 'other', effort: 'high' }).skipped).toBe(1);
    const changed = source(); changed.evidence[0]!.text += ' 新内容'; jobs.create(bundle([changed]), DEFAULT_SUMMARY_SETTINGS); await settle(jobs); expect(calls).toBe(1);
  });
  it('validates milestone-only references and refuses late results across import barriers', async () => {
    const db = database(); let release: (value: { value: unknown; usage: null; model: string }) => void = () => undefined;
    const jobs = new SummaryJobs(db, { summarize: () => new Promise(resolve => { release = resolve; }) }); queues.push(jobs);
    jobs.create(bundle(), DEFAULT_SUMMARY_SETTINGS); db.importSnapshot(createDemoSnapshot()); release({ value: { ...summary(), milestones: [milestone()] }, usage: null, model: 'test' }); await settle(jobs);
    expect(db.timeline.page('example').total).toBe(0);
    expect(() => validateMilestoneEvidence([milestone({ sourceRefs: ['unknown'] })], source().evidence)).toThrow();
    expect(() => validateMilestoneEvidence([milestone({ occurredAt: '2030-01-01' })], source().evidence)).toThrow();
  });
});
