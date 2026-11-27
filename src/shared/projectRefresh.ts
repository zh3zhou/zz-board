import type { SyncJob } from './summarySync.js';

export const LOCAL_REFRESH_LIMIT = 3;

/** A saved turn lifecycle is evidence about that turn, never a live Desktop signal. */
export function recordedTurnNotice(status: unknown): string {
  switch (status) {
    case 'inProgress': return '读取时该回合记录为未结束，不能判断现在是否仍在运行。';
    case 'interrupted': return '该回合的持久化记录为中断。';
    case 'failed': return '该回合的持久化记录为失败。';
    default: return '';
  }
}

export interface ProjectSourceCheck {
  threadKey: string;
  title: string;
  discovered: boolean;
  sourceUpdatedAt?: string;
  evidenceLatestAt?: string;
  /** Digest of exactly the bounded evidence handed to the summary queue. */
  evidenceFingerprint?: string;
  latestTurnNotice?: string;
  state: 'read' | 'unavailable' | 'not-read';
  reason: string;
}

/** A bounded local read, not a replacement for the Desktop full-source sync. */
export interface ProjectRefreshResult {
  projectKey: string;
  checkedAt: string;
  scope: 'local-codex';
  readCount: number;
  /** Successful discovery and usable evidence within the selected local window. */
  coverageComplete?: boolean;
  limitedExcerpts?: boolean;
  gaps: string[];
  job: SyncJob | null;
  /** Optional for older desktop responses. Discovery is not summary success. */
  sources?: ProjectSourceCheck[];
}

/** Local metadata only. An event's date never supplies either check timestamp. */
export interface SavedProjectCheck {
  projectKey: string;
  attemptedAt: string | null;
  lastVerifiedAt: string | null;
  latestEvidenceCheckAt: string | null;
  outcome: 'unknown' | 'checking' | 'updated' | 'unchanged' | 'partial' | 'failed';
  readCount: number;
  sources: ProjectSourceCheck[];
  limitedExcerpts: boolean;
  updatedThreadKeys: string[];
  jobId: string | null;
  failureCode: string | null;
}

const sourceFailures = new Set(['summary_format', 'invalid_output', 'invalid_reference', 'invalid_retirement', 'invalid_artifact', 'history_changed']);
export const transientProjectFailures = new Set(['account_read_timeout', 'initialization_timeout', 'runtime_busy', 'runtime_timeout', 'temporary_network_error']);
export function blockingCheckFailure(job: SyncJob): string | null {
  if (job.state !== 'paused') return null;
  const codes = (job.failures ?? []).map(failure => failure.code);
  return codes.find(code => !sourceFailures.has(code) && !transientProjectFailures.has(code))
    ?? codes.find(code => transientProjectFailures.has(code))
    ?? (!job.needsResubmit ? 'user_paused' : !codes.length ? 'paused' : null);
}

export function checkFailureMessage(code: string | null): string {
  switch (code) {
    case 'account_read_timeout': return '读取 Codex 账号信息超时。';
    case 'chatgpt_login_required': return '需要先在 Codex 登录。';
    case 'quota_exhausted': return 'Codex 额度暂时不可用。';
    case 'CODEX_ACCESS_REQUIRED': return '需要允许本机来源读取和模型调用。';
    case 'model_unavailable': return '所选模型暂不可用。';
    case 'runtime_timeout': return '整理对话超时。';
    case 'temporary_network_error': return '连接 Codex 时遇到临时网络问题。';
    case 'initialization_timeout': case 'runtime_busy': return 'Codex 暂时无法启动整理。';
    case 'cancelled': case 'interrupted': return '上次检查已中断。';
    case 'user_paused': return '整理已暂停，可在更新记录中继续。';
    default: return code?.includes('boundary') || code === 'ephemeral_unverified' ? '无法确认安全的总结环境。' : '本次检查未完成。';
  }
}
