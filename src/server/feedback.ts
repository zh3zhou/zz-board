import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_VERSION } from '../shared/version.js';
import { feedbackDeleteReceiptSchema, feedbackDiagnosticsSchema, feedbackReceiptSchema, MAX_FEEDBACK_BYTES,
  type FeedbackDeleteRequest, type FeedbackDiagnostics, type FeedbackReceipt, type FeedbackSubmission } from '../shared/feedback.js';

export interface FeedbackPublicConfig { envId: string; publishableKey: string }
export class FeedbackTransportError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

/** Publishable credentials are intentionally public. Reject accidental administrator tokens. */
export function parseFeedbackPublicConfig(value: unknown): FeedbackPublicConfig | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { envId, publishableKey } = value as Record<string, unknown>;
  if (typeof envId !== 'string' || !/^[a-z0-9][a-z0-9-]{5,100}$/.test(envId) || typeof publishableKey !== 'string' || publishableKey.length > 8192) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url').toString('utf8'));
    if (publishableKey.split('.').length !== 3 || claims.role !== 'anon') return undefined;
  } catch { return undefined; }
  return { envId, publishableKey };
}

function packagedManifest(): Record<string, unknown> | undefined {
  // Only the exact packaged server entry owns this manifest; never search bindings or board data.
  if (path.basename(process.argv[1] || '') !== 'server.cjs') return undefined;
  try {
    const file = path.join(path.dirname(process.argv[1]), 'manifest.json');
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 2_000_000) return undefined;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value.schemaVersion === 2 && value.appVersion === APP_VERSION ? value : undefined;
  } catch { return undefined; }
}

export function loadFeedbackPublicConfig(env: NodeJS.ProcessEnv): FeedbackPublicConfig | undefined {
  if (env.ZZ_BOARD_FEEDBACK_ENV_ID || env.ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY) return parseFeedbackPublicConfig({ envId: env.ZZ_BOARD_FEEDBACK_ENV_ID, publishableKey: env.ZZ_BOARD_FEEDBACK_PUBLISHABLE_KEY });
  return parseFeedbackPublicConfig(packagedManifest()?.publicFeedback);
}

export function buildFeedbackDiagnostics(manifest = packagedManifest(), now = new Date()): FeedbackDiagnostics {
  const base: FeedbackDiagnostics = { schemaVersion: 1, generatedAt: now.toISOString(), uiVersion: APP_VERSION, service: { state: 'connected', version: APP_VERSION } };
  if (manifest) {
    // Explicit projection, not health/manifest spreading. Files and public credentials stay local.
    const candidate = { appVersion: manifest.appVersion, nodeVersion: manifest.nodeVersion, platform: manifest.platform, arch: manifest.arch,
      sourceCommit: manifest.sourceCommit, releaseChannel: manifest.releaseChannel, declaredBuild: manifest.declaredBuild,
      fingerprint: undefined };
    const parsed = feedbackDiagnosticsSchema.safeParse({ ...base, runtime: candidate });
    if (parsed.success) {
      // A build identity never hashes incidental fields such as paths or credentials.
      parsed.data.runtime!.fingerprint = createHash('sha256').update(JSON.stringify(parsed.data.runtime)).digest('hex');
      return parsed.data;
    }
  }
  return base;
}

export class FeedbackTransport {
  private busy = false;
  constructor(private readonly config?: FeedbackPublicConfig, private readonly fetcher: typeof fetch = fetch, private readonly timeoutMs = 15_000) {}
  configured(): boolean { return Boolean(parseFeedbackPublicConfig(this.config)); }
  async submit(payload: FeedbackSubmission): Promise<FeedbackReceipt> {
    const value = await this.request({ action: 'submit', ...payload });
    const parsed = feedbackReceiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.reportId !== payload.reportId) throw new FeedbackTransportError(502, 'invalid_receipt', '结果未确认：接收回执无效，请保留原报告重试。');
    return parsed.data;
  }
  async delete(payload: FeedbackDeleteRequest) {
    const value = await this.request({ action: 'delete', ...payload });
    const parsed = feedbackDeleteReceiptSchema.safeParse(value);
    if (!parsed.success || parsed.data.reportId !== payload.reportId) throw new FeedbackTransportError(502, 'invalid_receipt', '删除结果未确认，请保留删除凭证重试。');
    return parsed.data;
  }
  private async request(payload: unknown): Promise<unknown> {
    const config = parseFeedbackPublicConfig(this.config);
    if (!config) throw new FeedbackTransportError(503, 'feedback_unconfigured', '反馈后端尚未接通，草稿仍保存在本机，可预览或复制。');
    if (this.busy) throw new FeedbackTransportError(429, 'feedback_busy', '另一份反馈正在发送，请稍后手动重试。');
    this.busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`https://${config.envId}.api.tcloudbasegateway.com/v1/functions/zzb-feedback?webfn=true`, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${config.publishableKey}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload)
      });
      if (!response.ok) {
        if (response.status >= 500) throw new FeedbackTransportError(502, 'feedback_unavailable', '结果未确认：反馈服务未返回有效回执，请保留草稿后手动重试。');
        const status = [400, 409, 410, 413, 429].includes(response.status) ? response.status : 503;
        throw new FeedbackTransportError(status, 'feedback_rejected', response.status === 429 ? '反馈暂时达到接收限额，请稍后手动重试。' : '反馈未取得有效回执，请保留草稿并稍后重试。');
      }
      if (!(response.headers.get('content-type') || '').includes('application/json') || !response.body) throw new FeedbackTransportError(502, 'invalid_receipt', '结果未确认：接收回执无效。');
      const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_FEEDBACK_BYTES) { await reader.cancel(); throw new FeedbackTransportError(502, 'invalid_receipt', '结果未确认：接收回执超出限制。'); }
        chunks.push(part.value);
      }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // The platform can wrap the function result. Business schema validation is still mandatory.
      if (value && Object.hasOwn(value, 'result')) {
        if (value.success === false || ['code', 'ret'].some(key => Object.hasOwn(value, key) && ![0, '0', ''].includes(value[key]))) {
          throw new FeedbackTransportError(502, 'invalid_receipt', '结果未确认：平台未返回成功回执。');
        }
        return typeof value.result === 'string' ? JSON.parse(value.result) : value.result;
      }
      return value;
    } catch (error) {
      if (error instanceof FeedbackTransportError) throw error;
      throw new FeedbackTransportError(502, controller.signal.aborted ? 'feedback_timeout' : 'feedback_unavailable', '结果未确认：连接中断或超时，草稿仍保留，请手动重试。');
    } finally { clearTimeout(timeout); this.busy = false; }
  }
}
