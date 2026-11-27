import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Agent, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const usage = 'node <Skill>/scripts/save-note.mjs --host-id <host> [--input <draft.json>] [--project-dir <absolute-dir> | --project-key <key>] [--thread-id <id>] [--thread-key <key>] [--request-id <id>] [--apply [--preview-token <token>]]';
const sha = text => createHash('sha256').update(text).digest('hex');
const directAgent = new Agent({ keepAlive: false });
const nativeId = value => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value) ? value.toLowerCase() : value;

class CaptureError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function options(args) {
  const names = new Set(['--host-id', '--input', '--project-dir', '--project-key', '--thread-id', '--thread-key', '--request-id', '--preview-token']);
  const values = new Map();
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (values.has(name)) throw new CaptureError('invalid_arguments', usage);
    if (name === '--apply') { values.set(name, true); continue; }
    const value = args[++i];
    if (!names.has(name) || !value?.trim() || value.startsWith('--')) throw new CaptureError('invalid_arguments', usage);
    values.set(name, value);
  }
  const hostId = values.get('--host-id');
  if (!hostId) throw new CaptureError('host_required', '需要当前对话实际所属的主机 ID。请从当前工作环境确认，再传 --host-id。');
  const providedId = values.get('--thread-id'), runtimeId = process.env.CODEX_THREAD_ID;
  const threadId = nativeId(providedId || runtimeId);
  if (!threadId) throw new CaptureError('thread_required', '当前运行时没有提供 CODEX_THREAD_ID。取得当前对话的准确技术 ID 后可传 --thread-id。');
  if (hostId === 'local' && providedId && runtimeId && threadId !== nativeId(runtimeId)) {
    throw new CaptureError('thread_mismatch', '指定的本机对话 ID 与当前 Codex 对话不一致。');
  }
  const key = values.get('--project-key'), directory = values.get('--project-dir');
  if ((directory && (key || !path.isAbsolute(directory))) || (hostId !== 'local' && !key)) {
    throw new CaptureError('invalid_project', '本机项目可用已登记的绝对目录。远程来源请指定已确认的 --project-key。');
  }
  if (hostId !== 'local' && !providedId) {
    throw new CaptureError('thread_required', '转交远程来源时请传原对话的 --thread-id，避免误用本机运行脚本的对话 ID。');
  }
  const requestId = values.get('--request-id'), previewToken = values.get('--preview-token');
  if ((requestId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(requestId)) || (previewToken && (!values.has('--apply') || !/^[\da-f]{16}\.[\da-f]{64}$/.test(previewToken)))) {
    throw new CaptureError('invalid_arguments', usage);
  }
  const threadKey = values.get('--thread-key');
  return { apply: values.has('--apply'), input: values.get('--input'), requestId, previewToken,
    project: key ? { projectKey: key } : { directory: directory || process.cwd() }, source: { hostId, threadId, ...(threadKey ? { threadKey } : {}) } };
}

async function readDraft(file) {
  if (!file && process.stdin.isTTY) throw new CaptureError('draft_required', '请用 --input 指定 UTF-8 JSON 草稿，或从标准输入传入。');
  const chunks = [];
  let size = 0, draft;
  try {
    for await (const chunk of file ? createReadStream(file) : process.stdin) {
      size += chunk.length;
      if (size > 160 * 1024) throw new Error();
      chunks.push(chunk);
    }
    draft = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { throw new CaptureError('invalid_draft', '草稿须为不超过 160 KiB 的 UTF-8 JSON，包含 title 和 body。'); }
  if (!draft || typeof draft.title !== 'string' || typeof draft.body !== 'string'
      || !draft.title.trim() || draft.title.length > 500 || !draft.body.trim() || draft.body.length > 20000
      || Object.keys(draft).some(k => k !== 'title' && k !== 'body')) {
    throw new CaptureError('invalid_draft', '草稿仅接受非空 title 和 body，分别最多 500 和 20000 个字符。');
  }
  return { title: draft.title.trim(), body: draft.body.replaceAll('\r\n', '\n') };
}

async function boundService() {
  let binding, url;
  try { binding = JSON.parse((await readFile(path.join(os.homedir(), '.codex', 'zz-board.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new CaptureError('binding_unavailable', '未能读取本机 ZZ Board 绑定。请先配置或恢复原桌面绑定。'); }
  try { url = new URL(binding?.boardUrl); } catch { /* validated below */ }
  if (binding?.schemaVersion !== 1 || typeof binding.dataDir !== 'string' || !path.isAbsolute(binding.dataDir) || !url
      || url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new CaptureError('invalid_binding', '绑定须包含本机回环 HTTP 地址和绝对数据目录。');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const store = sha(path.resolve(binding.dataDir).replaceAll('\\', '/').toLowerCase()).slice(0, 16);
  return { url, store };
}

const serviceErrors = {
  invalid_capture: '看板拒绝了便签草稿或来源格式。', wrong_board: '当前服务与预期看板不一致。',
  project_not_found: '没有找到已登记的项目，请核对项目根目录或项目键。', ambiguous_project: '目录对应多个项目，请用核实的项目键区分。',
  project_changed: '项目归属已变化，请重新核对目标。', project_archived: '项目或所属页面已归档。',
  source_not_found: '看板无法核实当前对话。请核对来源主机、技术 ID 与项目。',
  source_mismatch: '来源与项目不匹配。', ambiguous_source: '对话身份存在歧义，请使用已核实的来源键。',
  request_conflict: '同一请求号已用于其他内容或来源。', note_archived: '原便签已归档。',
  capture_retired: '原便签已撤销或删除。', capture_unavailable: '看板暂时无法处理本次请求，请保留原请求编号。'
};

// Use a direct loopback connection. node:http does not follow redirect responses.
async function call(url, route, payload) {
  const bytes = payload && Buffer.from(JSON.stringify(payload));
  let response;
  try {
    response = await new Promise((resolve, reject) => {
      const req = request(new URL(route, url), { method: bytes ? 'POST' : 'GET', agent: directAgent,
        signal: AbortSignal.timeout(12000), headers: bytes ? { 'content-type': 'application/json', 'content-length': bytes.length, 'x-zz-board-mutation': '1' } : {} }, resolve);
      req.on('error', reject);
      req.end(bytes);
    });
    const chunks = []; let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > 64 * 1024) throw new CaptureError('invalid_response', '本机服务的回执超过大小限制。');
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* handle status below */ }
    const status = response.statusCode;
    if (status < 200 || status >= 300) {
      if (typeof data?.code === 'string' && Object.hasOwn(serviceErrors, data.code)) throw new CaptureError(data.code, serviceErrors[data.code]);
      throw new CaptureError('board_request_failed', '本机看板请求失败（HTTP ' + status + '）。');
    }
    if (!data || typeof data !== 'object') throw new CaptureError('invalid_response', '本机看板没有返回有效回执。');
    return data;
  } catch (error) {
    if (error instanceof CaptureError) throw error;
    throw new CaptureError('board_unavailable', '无法取得已绑定本机看板的回执。请检查桌面是否已启动。');
  } finally { response?.destroy(); }
}

function receipt(data, request, mode) {
  const fields = ['noteId', 'projectKey', 'projectName', 'projectNodeId', 'pageId', 'pageName'];
  const source = data.source;
  const laterKey = request.source.threadKey && data.status !== 'created' && source?.hostId === 'local'
    && source.threadKey === null && data.resolvedThreadKey === request.source.threadKey ? request.source.threadKey : undefined;
  if (!(mode === 'apply' ? ['created','existing'] : ['preview']).includes(data.status)
      || !fields.every(k => typeof data[k] === 'string' && data[k].length)
      || (request.project.projectKey && data.projectKey !== request.project.projectKey)
      || (request.expectedProjectKey && data.projectKey !== request.expectedProjectKey)
      || !source || source.projectKey !== data.projectKey || !['codex','remote'].includes(source.sourceKind)
      || source.hostId !== request.source.hostId || nativeId(source.threadId) !== request.source.threadId
      || (source.hostId === 'local' && source.sourceKind !== 'codex')
      || !(typeof source.threadKey === 'string' && source.threadKey.length || source.threadKey === null && source.hostId === 'local')
      || (request.source.threadKey && source.threadKey !== request.source.threadKey && !laterKey)) {
    throw new CaptureError('invalid_receipt', '无法验证回执对应的便签、项目或来源对话。');
  }
  return { status: data.status, ...Object.fromEntries(fields.map(k => [k, data[k]])), ...(laterKey ? { resolvedThreadKey: laterKey } : {}),
    source: { projectKey: source.projectKey, sourceKind: source.sourceKind, hostId: source.hostId, threadId: source.threadId, threadKey: source.threadKey } };
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const opts = options(args), draft = await readDraft(opts.input);
  const { url, store } = await boundService();
  if (opts.previewToken && !opts.previewToken.startsWith(store + '.')) {
    throw new CaptureError('preview_changed', '桌面绑定与原预览不同，请重新核对。');
  }
  const health = await call(url, '/api/health');
  if (health.ok !== true || health.dataStoreId !== store) throw new CaptureError('wrong_board', serviceErrors.wrong_board);
  if (health.capabilities?.captureConversationNote !== true) throw new CaptureError('unsupported_board', '当前运行的 ZZ Board 尚不支持从对话保存便签，请使用带此功能的版本。');
  const fingerprint = sha(JSON.stringify([opts.source.hostId, opts.source.threadId, draft.title, draft.body]));
  const clientRequestId = opts.requestId || 'capture-' + fingerprint;
  const request = { expectedDataStoreId: store, clientRequestId, project: opts.project, source: opts.source, ...draft };
  const capture = (mode, params) => call(url, '/api/notes/from-conversation', { ...params, mode }).then(data => receipt(data, params, mode));
  const preview = await capture('preview', request);
  const previewToken = store + '.' + sha(JSON.stringify([store, preview.projectKey, preview.noteId, preview.source.threadKey, clientRequestId, fingerprint]));
  if (opts.previewToken && previewToken !== opts.previewToken) throw new CaptureError('preview_changed', '草稿、来源或目标与之前的预览不一致，请重新核对。');
  if (!opts.apply) { console.log(JSON.stringify({ ...preview, ...draft, clientRequestId, previewToken })); return; }
  try {
    const saved = await capture('apply', { ...request, expectedProjectKey: preview.projectKey });
    if (saved.noteId !== preview.noteId) throw new CaptureError('invalid_receipt', '保存回执与预览的便签 ID 不一致。');
    console.log(JSON.stringify({ ...saved, clientRequestId }));
  } catch (error) {
    error.retry = { clientRequestId, previewToken };
    throw error;
  }
}

main(process.argv.slice(2)).catch(error => {
  const known = error instanceof CaptureError;
  console.error(JSON.stringify({ error: known ? error.code : 'capture_failed', message: known ? error.message : '未能确认本次操作的结果。',
    ...(error.retry ? { retry: error.retry } : {}) }));
  process.exitCode = 1;
});
