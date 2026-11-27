import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { Agent, get } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { isCalendarDay, projectView, ReadError } from './project-view.mjs';

const usage = 'node <Skill>/scripts/read-project.mjs [--project-dir <absolute-path> | --project-key <key>] [--include-archived] [--latest | --note <id>] [--images preview|original] [--offset <n> --board-revision <n>] [--priority-date YYYY-MM-DD]';
function options(args) {
  const flags = new Map([['--project-dir','directory'], ['--project-key','projectKey'], ['--note','noteId'], ['--images','images'], ['--offset','offset'], ['--board-revision','boardRevision'], ['--priority-date','priorityDate']]);
  const r = {};
  const bad = () => { throw new ReadError('invalid_arguments', usage); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-archived' && !r.includeArchived) { r.includeArchived = true; continue; }
    if (args[i] === '--latest' && !r.latest) { r.latest = true; continue; }
    const key = flags.get(args[i]), value = args[++i];
    if (!key || key in r || !value || value.startsWith('--')) bad();
    if (key === 'offset' || key === 'boardRevision') {
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) bad();
      r[key] = Number(value);
    } else r[key] = value;
  }
  if ((r.directory && (r.projectKey || !path.isAbsolute(r.directory))) || (r.offset && r.boardRevision === undefined) || (r.latest && r.noteId) ||
      (r.images && (!['preview','original'].includes(r.images) || (!r.noteId && !r.latest) || r.offset)) ||
      (r.priorityDate && !isCalendarDay(r.priorityDate))) bad();
  return {directory: process.cwd(), ...r};
}

async function binding() {
  let b;
  try { b = JSON.parse((await readFile(path.join(os.homedir(), '.codex', 'zz-board.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new ReadError('binding_unavailable', '本机 ZZ Board 绑定缺失或不可读。请核对本机桌面的绑定后重试。'); }
  let url;
  try { url = new URL(b.boardUrl); } catch { /* invalid below */ }
  if (b?.schemaVersion !== 1 || typeof b.dataDir !== 'string' || !path.isAbsolute(b.dataDir) || !url ||
      url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new ReadError('invalid_binding', '绑定必须指定绝对数据目录和本机 HTTP 回环服务。');
  }
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const store = createHash('sha256').update(path.resolve(b.dataDir).replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,16);
  return {url, store};
}

// An explicit direct Agent keeps local reads off environment-configured HTTP proxies.
// node:http never follows redirects. Read errors must not echo arbitrary response bodies.
const localAgent = new Agent({keepAlive: false});
async function readRoute(base, route, { limit = 128 * 1024, noteHistory = false, image = false } = {}) {
  const unavailable = () => new ReadError('board_unavailable', '无法连接已绑定的本机 ZZ Board。请打开原看板后重试。');
  const tooLarge = () => new ReadError('response_too_large', '看板响应超过本地读取上限；本次没有返回部分结果。');
  let response;
  try {
    response = await new Promise((resolve, reject) => get(new URL(route, base), {
      agent: localAgent, signal: AbortSignal.timeout(12000)
    }, resolve).on('error', reject));
    const status = response.statusCode;
    if (noteHistory && status === 404) throw new ReadError('board_changed', '查询期间便签已不存在，请从首页重新读取。');
    if (image && status === 404) throw new ReadError('image_missing', '该图片在媒体库里暂不可用。');
    if (status !== 200) throw new ReadError('board_request_failed', '看板读取失败（HTTP ' + status + '）。');
    if (Number(response.headers['content-length']) > limit) throw tooLarge();
    const chunks = []; let bytes = 0;
    for await (const chunk of response) { bytes += chunk.length; if (bytes > limit) throw tooLarge(); chunks.push(chunk); }
    const bytesRead = Buffer.concat(chunks);
    if (image) return {bytes:bytesRead, mime:(response.headers['content-type'] ?? '').split(';')[0]};
    try { return JSON.parse(bytesRead.toString('utf8')); }
    catch { throw new ReadError('invalid_response', '看板没有返回有效 JSON。'); }
  } catch (e) { throw e instanceof ReadError ? e : unavailable(); }
  finally { response?.destroy(); }
}

async function readImages(url, note, variant) {
  const images = [];
  let directory;
  const preview = variant === 'preview';
  // IDs come exclusively from the selected, scope-checked note's validated blocks.
  for (const assetId of note.imageAssetIds) {
    try {
      const {bytes, mime} = await readRoute(url, '/api/media/' + assetId + '/' + variant, {
        image:true, limit:(preview ? 5 : 25) * 1024 * 1024
      });
      const png = mime === 'image/png' && bytes.length >= 33 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16) === 'IHDR';
      const jpeg = mime === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216;
      const webp = mime === 'image/webp' && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP';
      if (preview ? !png : (!(png || jpeg || webp) || createHash('sha256').update(bytes).digest('hex') !== assetId)) {
        throw new ReadError('invalid_image', '看板返回的图片格式或内容标识不符。');
      }
      directory ??= await mkdtemp(path.join(os.tmpdir(), 'zz-board-note-'));
      const file = path.join(directory, assetId + (png ? '.png' : jpeg ? '.jpg' : '.webp'));
      await writeFile(file, bytes, {flag:'wx',mode:0o600});
      images.push({assetId,variant,status:'ready',path:file});
    } catch (error) {
      images.push({assetId,variant,status:'unavailable',reason:error instanceof ReadError ? error.code : 'local_file_failed'});
    }
  }
  return images;
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  const query = options(args), {url, store} = await binding();
  const health = await readRoute(url, '/api/health');
  if (health?.ok !== true || health.dataStoreId !== store) throw new ReadError('wrong_board', '服务与绑定的数据目录不一致，已停止读取。');
  const route = query.priorityDate ? '/api/board?priorityDate=' + query.priorityDate : '/api/board';
  const board = await readRoute(url, route, {limit: 128 * 1024 * 1024});
  const result = projectView(board, query);
  if (query.boardRevision !== undefined && result.boardRevision !== query.boardRevision) {
    throw new ReadError('board_changed', '分页期间看板已变化。请从第一页重新读取。');
  }
  const noteId = result.selection?.noteId;
  if (noteId != null) {
    if (health.capabilities?.noteContentHistory !== true) result.contentHistory = {status: 'unavailable'};
    else {
      const h = await readRoute(url, '/api/notes/' + encodeURIComponent(noteId) + '/content-history', {noteHistory: true});
      if (h?.noteId !== noteId || !Number.isSafeInteger(h.boardRevision) || !Array.isArray(h.retainedEditTimes) ||
          !h.retainedEditTimes.every(t => typeof t === 'string' && Number.isFinite(Date.parse(t)))) {
        throw new ReadError('invalid_response', '无法验证便签历史的来源或时间。');
      }
      if (h.boardRevision !== result.boardRevision) throw new ReadError('board_changed', '看板在查询期间有变化，请重新读取。');
      result.contentHistory = {status: 'retained-applied-only', noteId: h.noteId, complete: false, retainedEditTimes: h.retainedEditTimes};
    }
  }
  if (query.images) result.images = result.notes.length ? await readImages(url, result.notes[0], query.images) : [];
  console.log(JSON.stringify(result));
}
main(process.argv.slice(2)).catch(error => {
  const known = error instanceof ReadError;
  console.error(JSON.stringify({error: known ? error.code : 'read_failed', message: known ? error.message : '读取未完成；没有可信的项目结果。', ...(known && error.candidates ? {candidateProjectKeys: error.candidates} : {})}));
  process.exitCode = 1;
});
