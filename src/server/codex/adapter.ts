import type { BoardSnapshotV1, SnapshotThread } from '../../shared/schema.js';

export function appServerThreadsToSnapshot(payload: unknown, observedAt = new Date().toISOString()): BoardSnapshotV1 {
  const items = findItems(payload);
  const projects = new Map<string, BoardSnapshotV1['projects'][number]>();
  const threads: SnapshotThread[] = [];
  items.forEach((raw, index) => {
    const threadId = text(raw.id) || text(raw.threadId);
    if (!threadId) return;
    const cwd = text(raw.cwd);
    const projectKey = cwd ? `cwd:${cwd.toLocaleLowerCase()}` : undefined;
    if (projectKey && !projects.has(projectKey)) {
      projects.set(projectKey, { projectKey, name: cwd!.split(/[\\/]/).filter(Boolean).at(-1) || cwd!, cwd, sidebarIndex: projects.size, observedAt });
    }
    const status = statusType(raw.status);
    threads.push({
      threadKey: `local:${threadId}`, sourceKind: 'codex', threadId, projectKey,
      title: text(raw.name) || text(raw.title) || text(raw.preview) || `Codex task ${index + 1}`, cwd, sidebarIndex: index, observedAt,
      sourceUpdatedAt: timestamp(raw.updatedAt) || timestamp(raw.updated_at),
      runtimeState: status === 'active' || status === 'running' ? 'running' : status === 'error' || status === 'systemError' ? 'error' : status === 'interrupted' ? 'interrupted' : 'idle',
      workState: 'insufficient_evidence', humanAction: 'uncertain', actionStrength: 'none',
      stopPoint: 'App Server can identify this task, but a semantic progress snapshot has not been imported yet.',
      evidence: 'Local Codex App Server thread/list', confidence: 'low'
    });
  });
  return {
    schemaVersion: 1, generatedAt: observedAt, source: 'codex-app-server',
    coverage: { projectsFound: projects.size, threadsFound: threads.length, deepRead: 0, fileChecked: 0, truncated: items.length >= 200, inaccessible: [] },
    projects: [...projects.values()], threads
  };
}

function findItems(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value)) return [];
  for (const key of ['data', 'threads', 'items']) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  return [];
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function timestamp(value: unknown): string | undefined {
  if (typeof value === 'number') return new Date(value > 1e12 ? value : value * 1000).toISOString();
  return text(value);
}
function statusType(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return isRecord(value) ? text(value.type) : undefined;
}
