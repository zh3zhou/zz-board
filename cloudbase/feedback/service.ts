import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { canonicalFeedback, feedbackDeleteSchema, feedbackSubmissionSchema, MAX_FEEDBACK_BYTES } from '../../src/shared/feedback.js';
import { feedbackRpcResultSchema, type FeedbackRpc } from './rpc.js';

export type FeedbackResponse = { status: number; body: Record<string, unknown>; retryAfter?: number };
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const failure = (status: number, code: string): FeedbackResponse => ({ status, body: { code } });

export async function processFeedback(body: unknown, rpc: FeedbackRpc): Promise<FeedbackResponse> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return failure(400, 'feedback_invalid');
  const { action, ...payload } = body as Record<string, unknown>;
  if (action !== 'submit' && action !== 'delete') return failure(400, 'feedback_invalid');
  const parsed = (action === 'submit' ? feedbackSubmissionSchema : feedbackDeleteSchema).safeParse(payload);
  if (!parsed.success) return failure(400, 'feedback_invalid');
  try {
    const value = parsed.data;
    const result = feedbackRpcResultSchema.parse(await rpc(action === 'submit' ? 'zzb_feedback_submit' : 'zzb_feedback_delete', action === 'submit' ? {
      p_report_id: value.reportId,
      p_payload: value,
      p_payload_hash: sha256(canonicalFeedback(value)),
      p_delete_token_hash: (value as { deleteTokenHash: string }).deleteTokenHash
    } : {
      p_report_id: value.reportId,
      p_delete_token_hash: sha256((value as { deleteToken: string }).deleteToken)
    }));
    if (result.status === 'accepted' || result.status === 'duplicate') {
      if (action !== 'submit') return failure(503, 'feedback_unavailable');
      if (!result.receipt || result.receipt.reportId !== value.reportId) return failure(503, 'feedback_unavailable');
      return { status: result.status === 'accepted' ? 201 : 200, body: result.receipt };
    }
    if (result.status === 'deleted') return action === 'delete' ? { status: 200, body: { schemaVersion: 1, reportId: value.reportId, deleted: true } } : failure(410, 'feedback_expired');
    if (result.status === 'conflict') return failure(409, 'feedback_conflict');
    if (result.status === 'expired') return failure(410, 'feedback_expired');
    if (result.status === 'forbidden') return failure(403, 'feedback_forbidden');
    if (result.status === 'rate_limited') return { ...failure(429, 'feedback_rate_limited'), retryAfter: 60 };
    return failure(400, 'feedback_invalid');
  } catch { return failure(503, 'feedback_unavailable'); }
}

export function createFeedbackHandler(rpc: FeedbackRpc, enabled = true) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const send = (result: FeedbackResponse) => {
      response.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(result.retryAfter ? { 'Retry-After': String(result.retryAfter) } : {}) });
      response.end(JSON.stringify(result.body));
    };
    // No request/body/header/environment logging. Health is deliberately constant.
    if (request.method === 'GET' && request.url === '/health') { send({ status: 200, body: { ok: true } }); return; }
    if (request.method !== 'POST') { send(failure(405, 'feedback_method')); return; }
    if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { send(failure(415, 'feedback_content_type')); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > MAX_FEEDBACK_BYTES) { send(failure(413, 'feedback_too_large')); request.resume(); return; }
        chunks.push(buffer);
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { send(failure(400, 'feedback_invalid')); return; }
      // Pausing collection must not prevent withdrawal of an existing report.
      if (!enabled && body !== null && typeof body === 'object' && !Array.isArray(body) && (body as Record<string, unknown>).action === 'submit') { send(failure(503, 'feedback_disabled')); return; }
      send(await processFeedback(body, rpc));
    } catch { if (!response.headersSent) send(failure(400, 'feedback_invalid')); }
  };
}
