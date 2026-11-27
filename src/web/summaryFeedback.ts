import type { SyncJob } from '../shared/summarySync.js';

export const processedCount = (job: SyncJob) => Math.min(job.total, job.completed + (job.failures?.length || 0));
export function summaryProblem(job: SyncJob): string {
  const code = job.failures?.[0]?.code;
  const codes = new Set(job.failures?.map(item => item.code));
  if (codes.has('quota_exhausted') || /额度当前不可用/.test(job.error || '')) return 'Codex 额度暂时不可用，请稍后重试。';
  if (codes.has('chatgpt_login_required')) return '请先确认 Codex 已登录，再重试。';
  if (codes.has('account_read_timeout')) return '读取 Codex 账号信息超时，可以稍后重试。';
  if (codes.has('CODEX_ACCESS_REQUIRED')) return '请先允许本机来源读取和模型调用。';
  if (codes.has('model_unavailable')) return '所选模型暂不可用，请在设置中检查。';
  if (codes.has('history_changed')) return '项目记录在整理期间有了变化，请重新预览后补充；已有历程保留。';
  if (code === 'runtime_timeout' || /超时/.test(job.error || '')) return '有对话整理时间较长，可以稍后重试。';
  if (['invalid_output', 'summary_format', 'invalid_reference', 'invalid_retirement', 'invalid_artifact'].includes(code || '')) return '有内容未通过核对，已保留原摘要。';
  return '部分内容暂未更新，已保留原摘要。';
}
