import { createPageInputSchema, updatePageInputSchema, archivePageInputSchema, pageViewportSchema } from '../shared/pages.js';
import { changeWallpaperSchema, wallpaperPresetId, wallpaperPresetSchema } from '../shared/wallpaper.js';
import fs from 'node:fs';
import { changePriorityIconsSchema } from '../shared/priorityIcons.js';
import path from 'node:path';
import os from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import {
  archiveNoteInputSchema,
  createAnnotationInputSchema,
  createInkStrokeInputSchema,
  createLinkInputSchema,
  updateLinkInputSchema,
  deleteLinkInputSchema,
  createNoteInputSchema,
  curatorReplySchema,
  deleteNoteInputSchema,
  deleteInkStrokeInputSchema,
  inkStrokeBatchInputSchema,
  interactionSettingsInputSchema,
  setActiveSkinInputSchema,
  setSkinSettingsInputSchema,
  setNodePrioritiesInputSchema,
  updateNodeInputSchema,
  updateNodesInputSchema,
  selectionActionSchema,
  updateInkStrokeInputSchema,
  viewportSchema
} from '../shared/schema.js';
import { calendarDateSchema } from '../shared/notePriority.js';
import { createDemoSnapshot } from '../shared/demo.js';
import { parseSnapshotText } from '../shared/snapshot.js';
import { APP_VERSION, SUPPORTED_SNAPSHOT_VERSIONS } from '../shared/version.js';
import { parseSkinReference, getSkinComponent, MAX_SKIN_PACKAGE_BYTES } from '../shared/skin.js';
import { dataStoreId, type AppConfig } from './config.js';
import { TrialDiagnostics } from './trialDiagnostics.js';
import { BoardDatabase, DeletedNoteRequestError, InvalidNodeOperationError, NotFoundError, RevisionConflictError } from './database.js';
import { CodexAppServerClient } from './codex/appServerClient.js';
import { CodexSummaryRuntime, SummaryRuntimeError } from './codex/summaryRuntime.js';
import { SummaryJobs, type SummaryRunner } from './summaryJobs.js';
import { ProjectRefresh } from './projectRefresh.js';
import { readSourceExcerpt } from './sourceExcerpt.js';
import { evidenceBundleSchema, MAX_EVIDENCE_BYTES, summarySettingsSchema } from '../shared/summarySync.js';
import { appServerThreadsToSnapshot } from './codex/adapter.js';
import { SkinLibrary } from './skinLibrary.js';
import { MediaStore } from './mediaStore.js';
import { InvalidImageError } from '../shared/imageFormat.js';
import { ImageExports } from './imageExports.js';
import { MAX_EXPORT_BYTES } from '../shared/imageExport.js';
import { MAX_IMAGE_BYTES } from '../shared/noteDocument.js';
import { captureConversationNoteSchema } from '../shared/conversationNote.js';
import { ConversationNoteError } from './conversationNoteCapture.js';
import { AutoCheck } from './autoCheck.js';
import { previewHistory } from './historyFiles.js';
import { feedbackSubmissionSchema, feedbackDeleteSchema, MAX_FEEDBACK_BYTES } from '../shared/feedback.js';
import { FeedbackTransport, FeedbackTransportError, buildFeedbackDiagnostics } from './feedback.js';
import { codexAccessInputSchema, CodexAccessRequiredError, requireCodexAccess, type CodexAccess, type CodexAccessRequirement, type CodexOperationGuard } from '../shared/codexAccess.js';

const snapshotBodySchema = z.object({ text: z.string().max(2_000_000) }).strict();
const curatorAskSchema = z.object({ question: z.string().trim().min(1).max(8_000) }).strict();
const curatorPairSchema = z.object({ threadId: z.string().trim().min(1).max(400) }).strict();
const themeSchema = z.object({ theme: z.enum(['archive-paper', 'ink-constellation']) }).strict();
const skinInstallBodySchema = z.object({ text: z.string().min(1).max(MAX_SKIN_PACKAGE_BYTES) }).strict();

function canonicalReviewSkill(): string {
  const candidates = [process.env.ZZ_BOARD_PROJECT_ROOT, process.cwd()];
  try {
    const binding = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'zz-board.json'), 'utf8'));
    if (typeof binding.projectRoot === 'string' && path.isAbsolute(binding.projectRoot)) candidates.push(binding.projectRoot);
  } catch { /* No local binding: do not guess a private data directory's parent. */ }
  for (const root of candidates) {
    if (!root) continue;
    const skill = path.resolve(root, 'skills/review-project-progress/SKILL.md');
    try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === 'zz-board' && fs.statSync(skill).isFile()) return JSON.stringify(skill); } catch { /* Try the next explicit location. */ }
  }
  return 'ZZ Board 源码仓库中的 skills/review-project-progress/SKILL.md（请先定位源码仓库，不使用旧的用户级副本）';
}

export interface AppServices {
  db: BoardDatabase;
  codex: CodexAppServerClient;
  skins: SkinLibrary;
  feedback: FeedbackTransport;
  summaryRuntime: SummaryRunner & { models(signal?: AbortSignal): Promise<Array<{ id: string; efforts: string[] }>>; status?(): { available: boolean; reason: string } };
}

export async function buildApp(config: AppConfig, services?: Partial<AppServices>): Promise<FastifyInstance> {
  const trial = config.trialDiagnostics ? new TrialDiagnostics(config.dataDir) : undefined;
  trial?.record({ event: 'service', outcome: 'start' });
  const db = services?.db || new BoardDatabase(config.databasePath, { cleanupDemoData: !config.demoMode });
  const codex = services?.codex || new CodexAppServerClient(config.codexCliPath);
  const skins = services?.skins || new SkinLibrary(config.skinDir);
  const feedback = services?.feedback || new FeedbackTransport(config.feedback);
  const summaryRuntime = services?.summaryRuntime || new CodexSummaryRuntime(config.codexCliPath, config.dataDir);
  const checkAccessEpoch = (epoch: number, required: CodexAccessRequirement) => {
    requireCodexAccess(db.getCodexAccess(), required);
    if (epoch !== db.getCodexAccessEpoch()) throw new CodexAccessRequiredError(required);
  };
  const withCodexOperation = async <T>(required: CodexAccessRequirement, work: (operation: CodexOperationGuard) => Promise<T>): Promise<T> => {
    requireCodexAccess(db.getCodexAccess(), required);
    const epoch = db.getCodexAccessEpoch(); const abort = new AbortController();
    const unsubscribe = db.onCodexAccessChange(() => abort.abort());
    const operation: CodexOperationGuard = { check: () => checkAccessEpoch(epoch, required), signal: abort.signal };
    const started = performance.now();
    trial?.record({ event: 'codex_read', outcome: 'start' });
    try {
      const value = await work(operation);
      operation.check();
      trial?.record({ event: 'codex_read', outcome: 'ok', elapsedMs: Math.round(performance.now() - started) });
      return value;
    } catch (error) {
      const revoked = abort.signal.aborted || epoch !== db.getCodexAccessEpoch();
      trial?.record({ event: 'codex_read', outcome: revoked ? 'blocked' : 'failed',
        code: revoked ? 'authorization_required' : 'read_error', elapsedMs: Math.round(performance.now() - started) });
      if (revoked) throw new CodexAccessRequiredError(required);
      throw error;
    } finally { unsubscribe(); }
  };
  const readCodexModels = () => withCodexOperation('localRead', operation => summaryRuntime.models(operation.signal));
  const summaryJobs = new SummaryJobs(db, trial ? trial.wrapModel(summaryRuntime) : summaryRuntime,
    trial ? job => trial.observeSyncJob(job) : undefined);
  const projectRefresh = new ProjectRefresh(db, codex, summaryJobs);
  const autoCheck = new AutoCheck(db, projectRefresh, summaryJobs);
  const media = new MediaStore(path.join(config.dataDir, 'media'), db);
  const imageExports = new ImageExports(db, config.dataDir, config.projectRoot);
  if (config.demoMode && db.isEmpty()) db.importSnapshot(createDemoSnapshot());

  const app = Fastify({ logger: true, bodyLimit: 2_100_000 });
  const events = new BoardEventStream();
  const unsubscribe = db.onMutation((boardRevision) => events.publish(boardRevision));
  const unsubscribeAccess = db.onCodexAccessChange(() => {
    const access = db.getCodexAccess();
    trial?.record({ event: 'codex_access', outcome: 'ok', localRead: access.localRead, modelUse: access.modelUse });
    events.publishAccess(access);
  });
  app.decorate('zzServices', { db, codex, skins, summaryRuntime, feedback });
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.raw.url?.startsWith('/api/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    reply.header('content-security-policy', "default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    if (request.headers['x-zz-board-mutation'] !== '1') {
      return reply.code(403).send({ error: 'A deliberate local mutation header is required.' });
    }
    const origin = request.headers.origin;
    if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
      return reply.code(403).send({ error: 'Cross-origin mutations are not allowed.' });
    }
  });
  app.addHook('preHandler', async request => {
    const route = request.routeOptions.url;
    let required: CodexAccessRequirement | null = null;
    if (route === '/api/codex/prepare' || route === '/api/summary/models' || route === '/api/sync/local' || route === '/api/projects/:projectKey/source-excerpt'
      || route === '/api/projects/:projectKey/history/preview' || route === '/api/summary/settings' && request.method === 'PATCH') required = 'localRead';
    if (['/api/projects/:projectKey/conversations/refresh', '/api/projects/:projectKey/conversations/earlier', '/api/projects/:projectKey/history',
      '/api/projects/:projectKey/refresh', '/api/sync/auto-check/run', '/api/curator/ask'].includes(route ?? '')
      || route === '/api/sync/jobs' && request.method === 'POST'
      || route === '/api/sync/jobs/:id/:action' && (request.params as { action?: string }).action === 'resume'
      || route === '/api/sync/auto-check' && request.method === 'PATCH' && (request.body as { enabled?: unknown } | null)?.enabled === true) required = 'modelUse';
    if (required) requireCodexAccess(db.getCodexAccess(), required);
    const projectKey = (request.params as { projectKey?: string } | undefined)?.projectKey;
    if (projectKey && route?.startsWith('/api/projects/') && (request.method !== 'GET' || route.endsWith('/history/preview')) && db.getProjectPagePolicy(projectKey).archived) {
      throw new InvalidNodeOperationError('页面已归档，仅显示已缓存内容；恢复后可检查项目。');
    }
  });

  trial?.register(app);
  app.get('/api/health', async () => ({
    ok: true,
    appVersion: APP_VERSION,
    snapshotSchemaVersions: SUPPORTED_SNAPSHOT_VERSIONS,
    capabilities: { noteContentHistory: true, captureConversationNote: true, weeklyReview: true },
    runtime: config.runtime,
    packagedRuntime: config.packagedRuntime,
    dataStoreId: dataStoreId(config.dataDir),
    mode: config.demoMode ? 'demo-capable' : 'local',
    ...(trial ? { trialDiagnostics: trial.status() } : {}),
    uptimeSeconds: Math.floor(process.uptime())
  }));
  app.get('/api/feedback/status', async () => ({ privateSubmissionConfigured: feedback.configured() }));
  app.get('/api/feedback/diagnostics', async () => buildFeedbackDiagnostics());
  app.get('/api/reviews/weekly', async request => {
    const {week} = z.object({week:z.enum(['previous', 'current']).default('previous')}).strict().parse(request.query);
    return {...db.getWeeklyReview(week), dataStoreId:dataStoreId(config.dataDir)};
  });
  app.post('/api/feedback/reports', { bodyLimit: MAX_FEEDBACK_BYTES, logLevel: 'silent' }, async (request, reply) => {
    const parsed = feedbackSubmissionSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'invalid_feedback', error: '反馈格式无效或超出限制，请重新预览。' });
    try { return await feedback.submit(parsed.data); }
    catch (error) { return reply.code(error instanceof FeedbackTransportError ? error.status : 502).send({ code: error instanceof FeedbackTransportError ? error.code : 'feedback_unavailable', error: error instanceof FeedbackTransportError ? error.message : '结果未确认，草稿仍保留。' }); }
  });
  app.post('/api/feedback/delete', { bodyLimit: 4096, logLevel: 'silent' }, async (request, reply) => {
    const parsed = feedbackDeleteSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ code: 'invalid_feedback', error: '删除凭证格式无效。' });
    try { return await feedback.delete(parsed.data); }
    catch (error) { return reply.code(error instanceof FeedbackTransportError ? error.status : 502).send({ code: error instanceof FeedbackTransportError ? error.code : 'feedback_unavailable', error: error instanceof FeedbackTransportError ? error.message : '删除结果未确认，请保留凭证重试。' }); }
  });
  app.get('/events', async (request, reply) => {
    reply.hijack();
    events.add(reply.raw, db.getBoardRevision(), db.getCodexAccess());
    request.raw.once('close', () => events.remove(reply.raw));
  });
  app.get('/api/board', async request => {
    const { priorityDate } = z.object({ priorityDate: calendarDateSchema.optional() }).parse(request.query);
    return db.getBoard(priorityDate);
  });
  app.post('/api/pages', async (request, reply) => reply.code(201).send(db.createPage(createPageInputSchema.parse(request.body).name)));
  app.patch('/api/pages/:id', async request => {
    const patch = updatePageInputSchema.parse(request.body);
    if (patch.backgroundSkinRef) {
      let reference: ReturnType<typeof parseSkinReference>;
      try { reference = parseSkinReference(patch.backgroundSkinRef); }
      catch { throw new InvalidNodeOperationError('背景引用格式无效。'); }
      if (reference.componentId !== 'background') throw new InvalidNodeOperationError('页面只能覆盖背景组件。');
      const skin = await skins.read(`${reference.skinId}@${reference.version}`);
      if (!skin || !getSkinComponent(skin.manifest, 'background')) throw new InvalidNodeOperationError('背景 Skin 尚未安装。');
    }
    return db.updatePage((request.params as { id: string }).id, patch);
  });
  app.post('/api/pages/:id/archive', async request => db.archivePage((request.params as { id: string }).id, archivePageInputSchema.parse(request.body)));
  app.delete('/api/pages/:id', async (request, reply) => {
    db.deletePage((request.params as { id: string }).id, deleteNoteInputSchema.parse(request.body).revision);
    return reply.code(204).send();
  });
  app.post('/api/pages/order', async request => { db.orderPages(z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(1000) }).strict().parse(request.body).ids); return db.pageNavigation(); });
  app.post('/api/pages/active', async request => { db.setActivePage(z.object({ pageId: z.string().min(1).max(100) }).strict().parse(request.body).pageId); return db.pageNavigation(); });
  app.post('/api/pages/default', async request => { db.setDefaultPage(z.object({ pageId: z.string().min(1).max(100) }).strict().parse(request.body).pageId); return db.pageNavigation(); });
  app.post('/api/pages/:id/viewport', async request => db.savePageViewport((request.params as { id: string }).id, pageViewportSchema.parse(request.body)));
  app.post('/api/nodes/:id/fold-all', async request => {
    const input = z.object({ folded: z.boolean(), revision: z.number().int().nonnegative() }).strict().parse(request.body);
    return db.foldAll((request.params as { id: string }).id, input.folded, input.revision);
  });

  app.get('/api/codex/access', async () => db.getCodexAccess());
  app.patch('/api/codex/access', async request => {
    const input = codexAccessInputSchema.parse(request.body);
    db.saveCodexAccess({ schemaVersion: 1, ...input, decidedAt: new Date().toISOString() });
    return db.getCodexAccess();
  });
  app.post('/api/codex/prepare', async () => {
    try {
      const models = await readCodexModels();
      return { available: models.length > 0, reason: models.length ? '本机登录身份与模型目录已读取；实际模型请求和剩余额度未验证。' : '本机未返回可用模型，请检查 Codex 登录。', models };
    } catch (error) {
      if (error instanceof CodexAccessRequiredError) throw error;
      return { available: false, reason: error instanceof SummaryRuntimeError ? error.message : '本机 Codex 准备未完成，请检查登录与 CLI。', models: [] };
    }
  });
  app.get('/api/settings/image-export', async () => imageExports.settings());
  app.patch('/api/settings/image-export', async (request, reply) => {
    const { directory } = z.object({ directory: z.string().min(1).max(2048).nullable() }).strict().parse(request.body);
    try { return imageExports.setDirectory(directory); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '导出路径无效。' }); }
  });
  let exporting = false;
  const exportRequests = new WeakSet<object>();
  const processingExports = new WeakSet<object>();
  const releaseExport = (request: object) => { if (exportRequests.delete(request)) exporting = false; };
  app.addHook('onResponse', async request => { if (!processingExports.has(request)) releaseExport(request); });
  app.addHook('onRequestAbort', async request => { if (!processingExports.has(request)) releaseExport(request); });
  app.addContentTypeParser('image/png', { parseAs: 'buffer', bodyLimit: MAX_EXPORT_BYTES }, (_request, body, done) => done(null, body));
  app.post('/api/image-exports', { bodyLimit: MAX_EXPORT_BYTES, onRequest: async (request, reply) => {
    if (exporting) return reply.code(429).send({ error: '另一张图片正在保存，请稍后重试。' });
    exporting = true; exportRequests.add(request);
  } }, async (request, reply) => {
    processingExports.add(request);
    try {
      const { kind } = z.object({ kind: z.enum(['region', 'note']).default('region') }).strict().parse(request.query);
      if (!Buffer.isBuffer(request.body)) throw new Error('请传入 PNG 图片。');
      return reply.code(201).send(await imageExports.save(request.body, kind));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return reply.code(400).send({ error: ['EACCES', 'EPERM'].includes(code || '') ? '导出文件夹无法写入，请在设置中更换路径。'
        : ['ENOSPC', 'EDQUOT'].includes(code || '') ? '磁盘空间不足，图片未能保存。'
        : error instanceof Error ? error.message : '图片未能保存。' });
    } finally { processingExports.delete(request); releaseExport(request); }
  });
  app.get('/api/summary/models', async () => {
    try { const models = await readCodexModels(); return { models, available: true, runtime: summaryRuntime.status?.() }; }
    catch (error) { if (error instanceof CodexAccessRequiredError) throw error; return { models: [], available: false, reason: error instanceof SummaryRuntimeError ? error.message : '本机 Codex 模型目录不可用，请检查登录与 CLI。' }; }
  });
  app.get('/api/summary/settings', async () => db.getSummarySettings());
  app.patch('/api/summary/settings', async (request, reply) => {
    const settings = summarySettingsSchema.parse(request.body);
    const models = await readCodexModels();
    if (!models.some(m => m.id === settings.model && m.efforts.includes(settings.effort))) return reply.code(400).send({ error: '当前登录不支持所选模型与推理强度。' });
    db.saveSummarySettings(settings); return settings;
  });
  app.get('/api/sync/jobs', async () => ({ jobs: summaryJobs.list() }));
  app.post('/api/projects/:projectKey/source-excerpt', { bodyLimit: 8192, logLevel: 'silent' }, async (request, reply) => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const { threadKey, sourceId } = z.object({ threadKey: z.string().min(1).max(700), sourceId: z.string().min(1).max(700) }).strict().parse(request.body);
    const disconnected = new AbortController();
    const cancel = () => disconnected.abort();
    reply.raw.once('close', cancel);
    try {
      return await withCodexOperation('localRead', operation => readSourceExcerpt(db, codex, projectKey, threadKey, sourceId, operation, disconnected.signal));
    } finally { reply.raw.off('close', cancel); }
  });
  app.get('/api/projects/:projectKey/conversations', async request => {
    const {projectKey}=z.object({projectKey:z.string().min(1).max(300)}).parse(request.params);
    const board=db.getBoard();
    if (!board.projects.some(p=>p.projectKey===projectKey)) throw new NotFoundError('找不到该项目。');
    return db.conversations.history(projectKey,board.threads);
  });
  app.post('/api/projects/:projectKey/conversations/refresh', async request => {
    const {projectKey}=z.object({projectKey:z.string().min(1).max(300)}).parse(request.params);
    return projectRefresh.conversations(projectKey);
  });
  app.post('/api/projects/:projectKey/conversations/earlier', async request => {
    const {projectKey}=z.object({projectKey:z.string().min(1).max(300)}).parse(request.params);
    const {threadKey,cursor}=z.object({threadKey:z.string().min(1).max(700),cursor:z.string().min(1).max(10000)}).strict().parse(request.body);
    return projectRefresh.earlier(projectKey,threadKey,cursor);
  });
  app.get('/api/projects/:projectKey/conversations/turns', async request => {
    const {projectKey}=z.object({projectKey:z.string().min(1).max(300)}).parse(request.params);
    const {threadKey,before,beforeTurnId,limit}=z.object({threadKey:z.string().min(1).max(700),before:z.coerce.number().int().optional(),beforeTurnId:z.string().min(1).max(400).optional(),limit:z.coerce.number().int().min(1).max(2000).default(20)}).parse(request.query);
    if (!db.getBoard().threads.some(t=>t.projectKey===projectKey && t.threadKey===threadKey)) throw new NotFoundError('找不到此项目中的对话。');
    return db.conversations.columnPage(threadKey,before,beforeTurnId,limit);
  });
  app.post('/api/projects/:projectKey/conversations/read', async request => {
    const {projectKey}=z.object({projectKey:z.string().min(1).max(300)}).parse(request.params);
    const {items}=z.object({items:z.array(z.object({threadKey:z.string().min(1).max(700),turnId:z.string().min(1).max(400),revision:z.number().int().nonnegative()}).strict()).max(2000)}).strict().parse(request.body);
    db.conversations.markRead(projectKey,items); return {ok:true};
  });
  app.get('/api/sync/auto-check', async () => autoCheck.status());
  app.patch('/api/sync/auto-check', async request => autoCheck.setEnabled(z.object({ enabled: z.boolean() }).strict().parse(request.body).enabled));
  app.post('/api/sync/auto-check/run', async () => { void autoCheck.tick(true); return autoCheck.status(); });
  app.get('/api/projects/:projectKey/timeline', async request => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const { offset, limit } = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(request.query);
    return db.timeline.page(projectKey, offset, limit);
  });
  app.post('/api/projects/:projectKey/timeline/read', async request => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const { throughSequence, keys } = z.object({ throughSequence: z.number().int().nonnegative(), keys: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(2000) }).strict().parse(request.body);
    db.timeline.markRead(projectKey, throughSequence, keys); return { ok: true };
  });
  app.get('/api/projects/:projectKey/timeline/:key/revisions', async request => {
    const { projectKey, key } = z.object({ projectKey: z.string().min(1).max(300), key: z.string().regex(/^[a-f0-9]{64}$/) }).parse(request.params);
    return { items: db.timeline.revisions(key).filter(item => item.projectKey === projectKey) };
  });
  app.get('/api/projects/:projectKey/history/preview', async request => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const result = await withCodexOperation('localRead', operation => previewHistory(db, projectKey, operation));
    return result.preview;
  });
  app.post('/api/projects/:projectKey/history', async (request, reply) => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const { fingerprint } = z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    const current = await withCodexOperation('modelUse', operation => previewHistory(db, projectKey, operation));
    if (fingerprint !== current.preview.fingerprint) return reply.code(409).send({ error: '项目记录已变化，请重新预览后再补充。' });
    return summaryJobs.createFiles(current.evidence, db.getSummarySettings());
  });
  app.get('/api/projects/:projectKey/refresh-status', async (request, reply) => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    if (!db.hasProject(projectKey)) return reply.code(404).send({ error: '找不到该项目。' });
    return db.projectChecks.get(projectKey);
  });
  app.post('/api/projects/:projectKey/refresh', async (request) => {
    const { projectKey } = z.object({ projectKey: z.string().min(1).max(300) }).parse(request.params);
    const options = z.object({ automatic: z.boolean().optional() }).strict().parse(request.body ?? {});
    return projectRefresh.refresh(projectKey, options);
  });
  app.post('/api/sync/jobs', { bodyLimit: MAX_EVIDENCE_BYTES }, async (request) => {
    const input = z.object({ bundle: evidenceBundleSchema, force: z.boolean().default(false) }).strict().parse(request.body);
    return summaryJobs.create(input.bundle, db.getSummarySettings(), input.force);
  });
  app.post('/api/sync/jobs/:id/:action', async (request) => {
    const { id, action } = z.object({ id: z.string().uuid(), action: z.enum(['pause','resume','cancel']) }).parse(request.params);
    return summaryJobs.control(id, action);
  });
  app.get('/api/sync/instructions', async (request) => {
    const force = (request.query as { force?: string }).force === 'true';
    return { prompt: `使用仓库版 Skill ${canonicalReviewSkill()} 执行 ZZ同步看板。通过 Codex Desktop 原生只读工具采集可访问的本地、远程与 ChatGPT 对话。若用户明确指定本次范围，只采集这些项目。用户未指定范围时，采集全部已保存项目；只传送有界证据包到本机看板，不先生成完整语义总结，不修改原任务。无法访问和截断明确报告。${force ? '本次明确授权重新总结采集到的证据，导入时使用 --force；不读取预算外历史。' : '仅总结内容变化的来源，不强制重算。'}` };
  });
  app.get('/api/skins', async () => {
    const items = await skins.list();
    const packages = await Promise.all(items.map((item) => skins.read(item.key)));
    return { items, manifests: packages.flatMap((item) => item ? [item.manifest] : []) };
  });
  app.get('/api/skins/:key/assets/:assetId', async (request, reply) => {
    const { key, assetId } = request.params as { key: string; assetId: string };
    const skinPackage = await skins.read(key);
    const asset = skinPackage?.assets.find((item) => item.id === assetId);
    if (!asset) return reply.code(404).send({ error: 'Skin asset not found.' });
    return reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .type(asset.mediaType)
      .send(Buffer.from(asset.dataBase64, 'base64'));
  });
  app.post('/api/skins/install', { bodyLimit: MAX_SKIN_PACKAGE_BYTES + 128_000 }, async (request, reply) => {
    const { text } = skinInstallBodySchema.parse(request.body);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { return reply.code(400).send({ error: 'Skin package is not valid JSON.' }); }
    return reply.code(201).send(await skins.install(parsed));
  });

  let mediaSlots = 0;
  const mediaRequests = new WeakSet<object>();
  const releaseMediaSlot = (request: object) => { if (mediaRequests.delete(request)) mediaSlots--; };
  app.addHook('onResponse', async request => releaseMediaSlot(request));
  app.addHook('onRequestAbort', async request => releaseMediaSlot(request));
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_request, body, done) => done(null, body));
  app.post('/api/media', { bodyLimit: MAX_IMAGE_BYTES, onRequest: async (request, reply) => {
    if (mediaSlots >= 2) return reply.code(429).header('retry-after', '2').send({ error: '正在处理其他图片，请稍后重试。' });
    mediaSlots++; mediaRequests.add(request);
  } }, async (request, reply) => {
    try { if (!Buffer.isBuffer(request.body)) throw new Error('图片上传格式无效。'); return reply.code(201).send(await media.import(request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '图片未能保存。', ...(error instanceof InvalidImageError && { code: 'invalid_image' }) }); }
  });
  app.get('/api/media/usage', async () => db.mediaUsage());
  app.get('/api/media/:id/:variant', async (request, reply) => {
    const { id, variant } = request.params as { id: string; variant: string };
    if (!['original', 'preview'].includes(variant)) return reply.code(404).send({ error: '图片不存在。' });
    try { const result = await media.read(id, variant === 'preview'); return reply.header('cache-control', 'private, max-age=31536000, immutable').type(result.mime).send(fs.createReadStream(result.file)); }
    catch { return reply.code(404).send({ error: '图片不存在或暂不可用。' }); }
  });
  app.post('/api/notes', async (request, reply) => reply.code(201).send(db.createNote(createNoteInputSchema.parse(request.body))));
  app.post('/api/notes/from-conversation', { bodyLimit: 192 * 1024, logLevel: 'silent' }, async (request, reply) => {
    const parsed = captureConversationNoteSchema.safeParse(request.body);
    if (!parsed.success) throw new ConversationNoteError(400, 'invalid_capture', '便签内容、来源或预览信息无效。');
    if (parsed.data.expectedDataStoreId !== dataStoreId(config.dataDir)) {
      throw new ConversationNoteError(409, 'wrong_board', '服务与绑定的看板数据目录不一致。');
    }
    const result = db.captureConversationNote(parsed.data);
    return reply.code(result.status === 'created' ? 201 : 200).send(result);
  });
  app.patch('/api/nodes/:id', async (request) => {
    const { id } = request.params as { id: string };
    return db.updateNode(id, updateNodeInputSchema.parse(request.body));
  });
  app.post('/api/nodes/batch', async (request) => db.updateNodes(updateNodesInputSchema.parse(request.body)));
  app.post('/api/selection', async (request) => db.applySelectionAction(selectionActionSchema.parse(request.body)));
  app.post('/api/nodes/priorities', async (request) => {
    const { updates } = setNodePrioritiesInputSchema.parse(request.body);
    return { nodes: db.setNodePriorities(updates), boardRevision: db.getBoardRevision() };
  });
  app.post('/api/notes/:id/archive', async (request) => {
    const { archived, revision } = archiveNoteInputSchema.parse(request.body);
    return db.setNoteArchived((request.params as { id: string }).id, archived, revision);
  });
  app.delete('/api/notes/:id', async (request, reply) => {
    const { revision } = deleteNoteInputSchema.parse(request.body);
    db.deleteNote((request.params as { id: string }).id, revision);
    return reply.code(204).send();
  });
  app.post('/api/annotations', async (request, reply) => {
    const input = createAnnotationInputSchema.parse(request.body);
    return reply.code(201).send(db.createAnnotation(input.targetNodeId, input.body));
  });
  app.post('/api/links', async (request, reply) => {
    const input = createLinkInputSchema.parse(request.body);
    return reply.code(201).send(db.createLink(input.sourceNodeId, input.targetNodeId, input.label));
  });
  app.patch('/api/links/:id', async (request) => db.updateLink((request.params as { id: string }).id, updateLinkInputSchema.parse(request.body)));
  app.delete('/api/links/:id', async (request, reply) => {
    db.deleteLink((request.params as { id: string }).id, deleteLinkInputSchema.parse(request.body).revision);
    return reply.code(204).send();
  });
  app.post('/api/ink-strokes', async (request, reply) => {
    const input = createInkStrokeInputSchema.parse(request.body);
    const result = db.applyInkBatch({ creates: [input], updates: [], deletes: [] });
    return reply.code(201).send(result.created[0]);
  });
  app.patch('/api/ink-strokes/:id', async (request) => {
    const id = (request.params as { id: string }).id;
    const patch = updateInkStrokeInputSchema.parse(request.body);
    return db.applyInkBatch({ creates: [], updates: [{ id, patch }], deletes: [] }).updated[0];
  });
  app.delete('/api/ink-strokes/:id', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const { revision } = deleteInkStrokeInputSchema.parse(request.body);
    db.applyInkBatch({ creates: [], updates: [], deletes: [{ id, revision }] });
    return reply.code(204).send();
  });
  app.post('/api/ink-strokes/batch', async (request) => db.applyInkBatch(inkStrokeBatchInputSchema.parse(request.body)));
  app.get<{Params: {id: string}}>('/api/notes/:id/content-history', async request => db.getNoteContentHistory(request.params.id));
  app.get('/api/history/status', async () => db.getHistoryStatus());
  app.post('/api/history/undo', async () => db.undo());
  app.post('/api/history/redo', async () => db.redo());

  app.post('/api/snapshots/preview', async (request) => {
    const snapshot = parseSnapshotText(snapshotBodySchema.parse(request.body).text);
    const board = db.getBoard();
    const existing = new Set(board.threads.map((thread) => thread.threadKey));
    return {
      schemaVersion: snapshot.schemaVersion,
      summaryLanguage: snapshot.schemaVersion >= 3 ? (snapshot as { summaryLanguage: string }).summaryLanguage : null,
      generatedAt: snapshot.generatedAt, projects: snapshot.projects.length, threads: snapshot.threads.length,
      projectBriefs: snapshot.schemaVersion !== 1 ? snapshot.projectBriefs.length : snapshot.projects.length,
      todos: snapshot.schemaVersion !== 1 ? snapshot.todos.length : null,
      todosDerivedOnImport: snapshot.schemaVersion === 1,
      newTasks: snapshot.threads.filter((thread) => !existing.has(thread.threadKey)).length,
      preservedTasks: snapshot.threads.filter((thread) => existing.has(thread.threadKey)).length,
      coverage: snapshot.coverage
    };
  });
  app.post('/api/snapshots/import', async (request) => db.importSnapshot(parseSnapshotText(snapshotBodySchema.parse(request.body).text)));
  app.post('/api/sync/local', async (_request, reply) => {
    try {
      const payload = await withCodexOperation('localRead', operation => codex.listThreads(200, operation));
      const snapshot = appServerThreadsToSnapshot(payload);
      return { snapshot: snapshot.coverage, imported: db.importSnapshot(snapshot) };
    } catch (error) {
      if (error instanceof CodexAccessRequiredError) throw error;
      return reply.code(503).send({ error: message(error), hint: 'Set CODEX_CLI_PATH to a trusted Codex CLI, or paste a Skill snapshot.' });
    }
  });

  app.post('/api/settings/theme', async (request) => {
    const { theme } = themeSchema.parse(request.body);
    db.setSetting('theme', theme);
    return { theme };
  });
  app.post('/api/settings/active-skin', async (request) => {
    const { skinRef } = setActiveSkinInputSchema.parse(request.body);
    db.setActiveSkin(skinRef);
    return { skinRef };
  });
  app.post('/api/settings/skin', async (request) => {
    const input = setSkinSettingsInputSchema.parse(request.body);
    db.setSkinSettings(input);
    return {
      activeSkinRef: db.getBoard().settings.activeSkinRef,
      components: db.getBoard().settings.skinComponents
    };
  });
  app.patch('/api/settings/wallpaper', async request => {
    const change = changeWallpaperSchema.parse(request.body);
    db.setSkinSettings({ wallpaper: change });
    return { wallpaper: change.value };
  });
  app.get<{ Params: { id: string } }>('/api/settings/wallpaper/presets/:id', async request =>
    db.getWallpaperPreset(wallpaperPresetId.parse(request.params.id)));
  app.post('/api/settings/wallpaper/presets', async (request, reply) => {
    const preset = wallpaperPresetSchema.parse(request.body);
    db.changeWallpaperPreset(preset.id, preset);
    return reply.code(204).send();
  });
  app.delete<{ Params: { id: string } }>('/api/settings/wallpaper/presets/:id', async (request, reply) => {
    db.changeWallpaperPreset(wallpaperPresetId.parse(request.params.id), null);
    return reply.code(204).send();
  });
  app.patch('/api/settings/priority-icons', async request => {
    const change = changePriorityIconsSchema.parse(request.body);
    db.setSkinSettings({ priorityIcons: change });
    return change.value;
  });
  app.patch('/api/settings/interaction', async (request) => {
    const settings = interactionSettingsInputSchema.parse(request.body);
    return db.setInteractionSettings(settings);
  });
  app.post('/api/settings/viewport', async (request) => {
    const viewport = viewportSchema.parse(request.body);
    db.setJsonSetting('viewport', viewport);
    return viewport;
  });
  app.post('/api/curator/pair', async (request) => {
    const { threadId } = curatorPairSchema.parse(request.body);
    db.setSetting('curatorThreadId', threadId);
    return { threadId };
  });
  app.post('/api/curator/ask', async (request, reply) => {
    const { question } = curatorAskSchema.parse(request.body);
    const curatorThreadId = db.getSetting('curatorThreadId');
    if (!curatorThreadId) return reply.code(409).send({ error: 'Pair one dedicated curator task first.' });
    try {
      const response = await withCodexOperation('modelUse', operation => codex.sendCuratorTurn(curatorThreadId, curatorPrompt(question, db.getBoard()), operation));
      return curatorReplySchema.parse(normalizeCuratorReply(response));
    } catch (error) {
      if (error instanceof CodexAccessRequiredError) throw error;
      return reply.code(503).send({ error: message(error), hint: 'The curator is read-only and never posts into project tasks.' });
    }
  });
  app.get('/api/daily-review', async () => {
    const board = db.getBoard();
    const projectPriority = new Map(board.nodes
      .filter((node) => node.kind === 'task' && node.projectKey && node.effectivePriority)
      .map((node) => [node.projectKey!, node.effectivePriority!]));
    const projectOrder = new Map(board.projects.map((project, index) => [project.projectKey, project.sidebarIndex ?? index]));
    const rank = { p1: 0, p2: 1 } as const;
    const chosen = [...board.todos]
      .filter((todo) => !todo.missingSince && projectPriority.has(todo.projectKey))
      .sort((a, b) => rank[projectPriority.get(a.projectKey)!] - rank[projectPriority.get(b.projectKey)!] ||
        (projectOrder.get(a.projectKey) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.projectKey) ?? Number.MAX_SAFE_INTEGER) ||
        (a.sidebarIndex ?? Number.MAX_SAFE_INTEGER) - (b.sidebarIndex ?? Number.MAX_SAFE_INTEGER) || a.todoKey.localeCompare(b.todoKey));
    const items = chosen.map((todo) => ({
      todoKey: todo.todoKey,
      projectKey: todo.projectKey,
      manualPriority: projectPriority.get(todo.projectKey),
      threadKey: todo.sourceThreadKeys[0] ?? null,
      sourceThreadKeys: todo.sourceThreadKeys,
      title: todo.title,
      action: todo.kind,
      strength: todo.strength,
      minimumAction: todo.minimumAction,
      why: todo.whyNow,
      unlocks: todo.unlocks,
      confidence: todo.confidence
    }));
    return { date: board.priorityDate, items, note: '清单按你在看板上设置的项目优先级排列。' };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConversationNoteError) return reply.code(error.status).send({ error: error.message, code: error.code });
    if (_request.routeOptions.url === '/api/notes/from-conversation') {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 400 || status === 413 || status === 415) return reply.code(status).send({ code: 'invalid_capture', error: '便签请求无效或超出限制。' });
      return reply.code(500).send({ code: 'capture_unavailable', error: '看板未能完成请求，请使用相同请求编号重试。' });
    }
    if (error instanceof CodexAccessRequiredError) {
      trial?.record({ event: 'codex_access', outcome: 'blocked', code: 'authorization_required' });
      return reply.code(403).send({ error: error.message, code: error.code, required: error.required });
    }
    if (_request.routeOptions.url === '/api/trial/diagnostics/events') {
      return reply.code(400).send({ code: 'invalid_trial_event' });
    }
    if (_request.routeOptions.url === '/api/projects/:projectKey/source-excerpt') {
      const status = (error as { statusCode?: number }).statusCode;
      if (error instanceof InvalidNodeOperationError) return reply.code(409).send({ error: '此项目已归档。' });
      if (error instanceof z.ZodError || status === 400 || status === 413 || status === 415) return reply.code(status ?? 400).send({ error: '来源定位请求无效。' });
      return reply.code(503).send({ error: '暂时无法读取本机来源。' });
    }
    if (_request.raw.url?.startsWith('/api/feedback/')) {
      const status = (error as { statusCode?: number }).statusCode;
      return reply.code(status === 413 ? 413 : 400).send({ code: 'invalid_feedback', error: '反馈请求无效或超出限制，请保留草稿并重新预览。' });
    }
    if (error instanceof RevisionConflictError) return reply.code(409).send({ error: error.message, current: error.current });
    if (error instanceof NotFoundError) return reply.code(404).send({ error: error.message });
    if (error instanceof InvalidNodeOperationError) return reply.code(409).send({ error: error.message });
    if (error instanceof DeletedNoteRequestError) return reply.code(410).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request.', details: error.issues });
    app.log.error(error);
    return reply.code(500).send({ error: message(error) });
  });

  const webRoot = path.resolve(process.cwd(), 'dist/web');
  if (fs.existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    app.setNotFoundHandler((request, reply) => {
      if (request.raw.url?.startsWith('/api/')) return reply.code(404).send({ error: 'Not found.' });
      return reply.sendFile('index.html');
    });
  }
  app.addHook('preClose', async () => { unsubscribe(); unsubscribeAccess(); events.close(); });
  app.addHook('onListen', async () => {
    trial?.record({ event: 'service', outcome: 'ok' });
    if (!config.demoMode && process.env.ZZ_BOARD_AUTO_CHECK !== '0') autoCheck.start();
  });
  app.addHook('onClose', async () => {
    trial?.record({ event: 'service', outcome: 'ok', code: 'stopped' });
    autoCheck.dispose(); projectRefresh.dispose(); summaryJobs.dispose(); codex.dispose(); db.close();
  });
  return app;
}

function curatorPrompt(question: string, board: ReturnType<BoardDatabase['getBoard']>): string {
  const context = {
    projectBriefs: board.projectBriefs.slice(0, 80).map((brief) => ({
      projectKey: brief.projectKey, overview: brief.overview, currentStage: brief.currentStage,
      stopPoint: brief.stopPoint, codexOrExternalNext: brief.codexOrExternalNext, confidence: brief.confidence
    })),
    todos: board.todos.slice(0, 80).map((todo) => ({
      todoKey: todo.todoKey, projectKey: todo.projectKey, sourceThreadKeys: todo.sourceThreadKeys,
      title: todo.title, minimumAction: todo.minimumAction, whyNow: todo.whyNow, confidence: todo.confidence
    })),
    threads: board.threads.slice(0, 80).map((thread) => ({
      threadKey: thread.threadKey, title: thread.title, stopPoint: thread.stopPoint, humanAction: thread.humanAction,
      confidence: thread.confidence, observedAt: thread.lastObservedAt
    }))
  };
  return `You are the dedicated read-only curator for ZZ Board. Answer only from the supplied local snapshot. Never send messages to project tasks and never claim live state. If a project task must continue, return a handoff draft for the user to approve. For kind=answer set answer and relatedThreadKeys, leaving reason/targetThreadKey/draft null. For kind=handoff set reason/targetThreadKey/draft, leaving answer null and relatedThreadKeys empty.\n\nQuestion: ${question}\n\nSnapshot: ${JSON.stringify(context)}`;
}
function normalizeCuratorReply(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const item = value as Record<string, unknown>;
  return item.kind === 'handoff'
    ? { kind: 'handoff', reason: item.reason || '', targetThreadKey: item.targetThreadKey ?? null, draft: item.draft || '' }
    : { kind: 'answer', answer: item.answer || '', relatedThreadKeys: Array.isArray(item.relatedThreadKeys) ? item.relatedThreadKeys : [] };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

class BoardEventStream {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat = setInterval(() => {
    for (const client of this.clients) client.write(': keep-alive\n\n');
  }, 20_000).unref();

  add(client: ServerResponse, boardRevision: number, access: CodexAccess): void {
    client.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    this.clients.add(client);
    this.write(client, boardRevision);
    this.writeAccess(client, access);
  }

  remove(client: ServerResponse): void {
    this.clients.delete(client);
  }

  publish(boardRevision: number): void {
    for (const client of this.clients) this.write(client, boardRevision);
  }

  publishAccess(access: CodexAccess): void {
    for (const client of this.clients) this.writeAccess(client, access);
  }

  private writeAccess(client: ServerResponse, access: CodexAccess): void {
    if (!client.destroyed) client.write(`event: codex-access\ndata: ${JSON.stringify(access)}\n\n`);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  private write(client: ServerResponse, boardRevision: number): void {
    if (!client.destroyed) client.write(`data: ${JSON.stringify({ boardRevision })}\n\n`);
  }
}

declare module 'fastify' {
  interface FastifyInstance { zzServices: AppServices }
}
