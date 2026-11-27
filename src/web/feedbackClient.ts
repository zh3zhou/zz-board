import { feedbackDeleteReceiptSchema, feedbackDiagnosticsSchema, feedbackReceiptSchema, feedbackSubmissionSchema, FEEDBACK_RETRY_MS } from '../shared/feedback.js';
import type { FeedbackDiagnostics, FeedbackReceipt, FeedbackSubmission } from '../shared/feedback.js';
import { APP_VERSION, RELEASE_CHANNEL } from '../shared/version.js';
import type { FeedbackDraft, FeedbackFields, FeedbackPersistence, LocalFeedbackReceipt, PreparedFeedback } from './feedbackStore.js';

const mutationHeaders = { 'content-type': 'application/json', 'x-zz-board-mutation': '1' };
export class FeedbackClientError extends Error {
  constructor(readonly code: 'invalid' | 'unavailable' | 'rate_limited' | 'expired' | 'uncertain' | 'storage', message: string) { super(message); this.name = 'FeedbackClientError'; }
}
export interface FeedbackTransport {
  submit(input: FeedbackSubmission): Promise<FeedbackReceipt>;
  remove(reportId: string, deleteToken: string): Promise<void>;
}
export type FeedbackSubmissionResult = { state: 'received'; receipt: FeedbackReceipt } | { state: 'deleting' | 'deleted' };

function unavailableDiagnostics(): FeedbackDiagnostics {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), uiVersion: APP_VERSION, service: { state: 'unavailable' }, errors: [] };
}

export async function readFeedbackDiagnostics(fetcher: typeof fetch = fetch): Promise<{ diagnostics: FeedbackDiagnostics; unavailable: boolean }> {
  try {
    const response = await fetcher('/api/feedback/diagnostics', { signal: AbortSignal.timeout(3000), cache: 'no-store' });
    if (!response.ok) throw new Error();
    const diagnostics = feedbackDiagnosticsSchema.parse(await response.json());
    // The UI version belongs to this loaded page, not necessarily the connected server.
    return { diagnostics: { ...diagnostics, uiVersion: APP_VERSION }, unavailable: false };
  } catch { return { diagnostics: unavailableDiagnostics(), unavailable: true }; }
}

export async function prepareFeedback(fields: FeedbackFields, diagnostics?: FeedbackDiagnostics, now = new Date()): Promise<PreparedFeedback> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const deleteToken = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(deleteToken));
  const deleteTokenHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const parsed = feedbackSubmissionSchema.safeParse({
    schemaVersion: 1, reportId: crypto.randomUUID(), createdAt: now.toISOString(), retryUntil: new Date(now.getTime() + FEEDBACK_RETRY_MS).toISOString(),
    kind: fields.kind, goal: fields.goal, actual: fields.actual, expected: fields.expected, dataImpact: fields.dataImpact,
    ...(fields.contact?.trim() ? { contact: fields.contact.trim() } : {}), ...(diagnostics ? { diagnostics } : {}), deleteTokenHash
  });
  if (!parsed.success) throw new FeedbackClientError('invalid', '请填写问题或想法，并检查各段文字长度；反馈和诊断信息不可超过限制。');
  return { submission: parsed.data, deleteToken };
}

export function feedbackDraftText(fields: FeedbackFields, diagnostics?: FeedbackDiagnostics): string {
  return JSON.stringify({ kind: fields.kind, goal: fields.goal, actual: fields.actual, expected: fields.expected, dataImpact: fields.dataImpact,
    ...(fields.contact?.trim() ? { contact: fields.contact.trim() } : {}), ...(diagnostics ? { diagnostics } : {}) }, null, 2);
}

export const githubIssueForms = {
  problem: 'https://github.com/zh3zhou/zz-board/issues/new?template=bug.yml',
  idea: 'https://github.com/zh3zhou/zz-board/issues/new?template=feature.yml'
} as const;

export function publicFeedbackText(fields: FeedbackFields): string {
  const idea = fields.kind === 'idea';
  const impact = { unknown: '不确定', none: '没有影响', possible: '内容可能缺失或错误' };
  return [
    `ZZ Board ${APP_VERSION} / ${RELEASE_CHANNEL} · ${idea ? '使用建议' : '问题反馈'}`,
    fields.goal.trim() && `想完成的事\n${fields.goal.trim()}`,
    fields.actual.trim() && `${idea ? '想法或体验' : '实际表现与复现步骤'}\n${fields.actual.trim()}`,
    fields.expected.trim() && `期望的结果\n${fields.expected.trim()}`,
    !idea && `数据影响\n${impact[fields.dataImpact]}`
  ].filter(Boolean).join('\n\n');
}

export function feedbackPreview(submission: FeedbackSubmission): string {
  return JSON.stringify(feedbackSubmissionSchema.parse(submission), null, 2);
}

export function createFeedbackTransport(fetcher: typeof fetch = fetch): FeedbackTransport {
  async function send(url: string, body: unknown): Promise<Response> {
    let response: Response;
    try { response = await fetcher(url, { method: 'POST', headers: mutationHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) }); }
    catch { throw new FeedbackClientError('uncertain', '未取得有效回执，结果未确认。请保留本机凭证后手动重试。'); }
    if (response.status === 429) throw new FeedbackClientError('rate_limited', '请求较频繁，请稍后手动重试。');
    if (response.status === 410) throw new FeedbackClientError('expired', '这份请求已过期或已删除，请新建反馈；原删除凭证仍保留。');
    if (response.status === 400 || response.status === 413 || response.status === 409) throw new FeedbackClientError('invalid', '本次请求未获接受，请检查内容或凭证；此前请求的结果请以已有回执为准。');
    if (!response.ok) {
      // Only this local, pre-network error proves that the current request was not forwarded.
      const detail: unknown = response.status === 503 ? await response.json().catch(() => null) : null;
      if (detail && typeof detail === 'object' && 'code' in detail && detail.code === 'feedback_unconfigured') {
        throw new FeedbackClientError('unavailable', '反馈服务尚未启用，本次请求未转发。草稿和凭证已保留。');
      }
      throw new FeedbackClientError('uncertain', '服务未返回有效回执，结果未确认。请保留本机凭证后手动重试。');
    }
    return response;
  }
  return {
    async submit(input) {
      const response = await send('/api/feedback/reports', input);
      const receipt = feedbackReceiptSchema.safeParse(await response.json().catch(() => null));
      if (!receipt.success || receipt.data.reportId !== input.reportId) throw new FeedbackClientError('uncertain', '没有取得有效的送达回执，结果未确认。请保留原报告后重试。');
      return receipt.data;
    },
    async remove(reportId, deleteToken) {
      const response = await send('/api/feedback/delete', { schemaVersion: 1, reportId, deleteToken });
      const result = feedbackDeleteReceiptSchema.safeParse(await response.json().catch(() => null));
      if (!result.success || result.data.reportId !== reportId) throw new FeedbackClientError('uncertain', '没有取得有效的删除回执，结果未确认。请保留凭证后重试删除。');
    }
  };
}

export async function submitFeedback(draft: FeedbackDraft & { prepared: PreparedFeedback }, store: FeedbackPersistence, transport: FeedbackTransport = createFeedbackTransport()): Promise<FeedbackSubmissionResult> {
  if (Date.parse(draft.prepared.submission.retryUntil) <= Date.now()) throw new FeedbackClientError('expired', '这份反馈已超过 24 小时重试期，请重新预览并创建新报告。原删除凭证仍保留。');
  // This transaction creates both the frozen report and its deletion capability before any network write.
  await store.savePrepared(draft);
  let receipt: FeedbackReceipt;
  try { receipt = await transport.submit(draft.prepared.submission); }
  catch (error) { await store.markUncertain(draft.prepared.submission.reportId).catch(() => {}); throw error; }
  let state: 'received' | 'deleting' | 'deleted';
  try { state = await store.markReceived(receipt); }
  catch { throw new FeedbackClientError('storage', '服务已返回接收回执，但本机回执未能更新。删除凭证已预先保存，可用同一报告重试确认。'); }
  return state === 'received' ? { state, receipt } : { state };
}

export async function deleteFeedback(record: LocalFeedbackReceipt, store: FeedbackPersistence, transport: FeedbackTransport = createFeedbackTransport()): Promise<void> {
  if (record.state === 'deleted') return;
  // Stop future submission even when deletion subsequently loses its acknowledgement.
  await store.markDeleting(record.reportId);
  await transport.remove(record.reportId, record.deleteToken);
  try { await store.markDeleted(record.reportId); }
  catch { throw new FeedbackClientError('storage', '服务已确认删除，但本机回执未能更新。可安全重试删除。'); }
}

export function deletionCredential(record: LocalFeedbackReceipt): string {
  return JSON.stringify({ schemaVersion: 1, reportId: record.reportId, deleteToken: record.deleteToken }, null, 2);
}

export function downloadFeedbackText(text: string, filename: string): void {
  const type = filename.endsWith('.json') ? 'application/json' : 'text/plain';
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
