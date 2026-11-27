import type { EvidenceBundle, SourceThread } from '../../src/shared/summarySync.js';
import type { ThreadSummary } from '../../src/shared/schema.js';
export const time = '2026-09-09T08:00:00.000Z';
export function source(id = 'a', kind: SourceThread['sourceKind'] = 'codex'): SourceThread {
  return { threadKey: `${kind}:local:${id}`, threadId: id, projectKey: 'example', hostId: 'local', sourceKind: kind,
    title: '合成任务', sourceUpdatedAt: time, evidenceCheckedAt: time, runtimeState: 'idle', readComplete: true,
    readReason: '已读取最近交付。', evidence: [{ id: `${id}:result`, role: 'assistant', occurredAt: time, turnId: `${id}:turn`, path: null, text: '示例程序 1.2 已构建。' }] };
}
export function summary(id = 'a'): ThreadSummary {
  return { headline: '示例程序已构建', stopPoint: '构建交付结束，未明确后续动作。', stopPointRefs: [`${id}:result`], workState: 'stage_closed', confidence: 'high',
    achievements: [{ id: 'build', title: '完成构建', detail: '合成示例构建完成。', occurredAt: time, sourceRefs: [`${id}:result`], artifactIds: [] }],
    artifacts: [], versions: [{ version: '1.2', stage: 'built', sourceRefs: [`${id}:result`] }], nextStep: null, nextStepReason: 'not_stated', resolvedTodos: [] };
}
export function bundle(threads = [source()]): EvidenceBundle {
  return { schemaVersion: 1, generatedAt: time, projects: [{ projectKey: 'example', name: '合成项目', observedAt: time, sidebarIndex: 0 }], threads,
    coverage: { projectsFound: 1, threadsFound: threads.length, deepRead: threads.length, fileChecked: 0, truncated: false, inaccessible: [] } };
}
