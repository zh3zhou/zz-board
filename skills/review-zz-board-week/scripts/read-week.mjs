import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Agent, get } from 'node:http';
import os from 'node:os';
import path from 'node:path';

const usage = 'node <Skill>/scripts/read-week.mjs [--week previous|current]';
class ReadError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function binding() {
  let value;
  try { value = JSON.parse((await readFile(path.join(os.homedir(), '.codex', 'zz-board.json'), 'utf8')).replace(/^\uFEFF/, '')); }
  catch { throw new ReadError('binding_unavailable', '本机 ZZ Board 绑定不可读，本次没有读到周报资料。'); }
  let url;
  try { url = new URL(value.boardUrl); } catch { /* Validate below. */ }
  if (!url || value?.schemaVersion !== 1 || typeof value.dataDir !== 'string' || !path.isAbsolute(value.dataDir) ||
      url.protocol !== 'http:' || !['127.0.0.1','[::1]','localhost'].includes(url.hostname) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) throw new ReadError('invalid_binding', '绑定需要本机回环 HTTP 地址和绝对数据目录。');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  const store = createHash('sha256').update(path.resolve(value.dataDir).replaceAll('\\','/').toLowerCase()).digest('hex').slice(0,16);
  return {url, store};
}

// node:http makes direct GET requests, does not follow redirects, and never prints an arbitrary error body.
const agent = new Agent({keepAlive:false});
async function read(url, route, limit) {
  let response;
  try {
    response = await new Promise((resolve,reject) => get(new URL(route,url), {agent, signal:AbortSignal.timeout(12000)}, resolve).on('error',reject));
    if (response.statusCode !== 200) throw new ReadError('board_request_failed', '周报读取失败（HTTP ' + response.statusCode + '）。');
    const tooLarge = () => new ReadError('response_too_large','周报响应超过读取上限，本次没有返回部分项目。');
    if (Number(response.headers['content-length']) > limit) throw tooLarge();
    const chunks = []; let bytes = 0;
    for await (const chunk of response) { bytes += chunk.length; if (bytes > limit) throw tooLarge(); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ReadError('invalid_response','服务返回了无效的周报资料。'); }
  } catch (error) {
    if (error instanceof ReadError) throw error;
    throw new ReadError('board_unavailable','无法连接已绑定的 ZZ Board，本次没有读到周报资料。请打开看板后重新运行。');
  } finally { response?.destroy(); }
}

const validCount = value => Number.isSafeInteger(value) && value >= 0;
const text = (value, size) => typeof value === 'string' && value.length > 0 && value.length <= size * 2 && [...value].length <= size;
const reference = (value, size) => text(value,size) && !/[^\p{L}\p{M}\p{N} ._:@-]/u.test(value) && !/(?:^|:)(?:cwd|path):/i.test(value);
function check(condition) {
  if (!condition) throw new ReadError('invalid_response','无法验证周报的日期、覆盖范围或记录格式。');
}
function pickedCounts(obj, keys) {
  check(obj && keys.every(k => validCount(obj[k])));
  return Object.fromEntries(keys.map(k => [k, obj[k]]));
}
function calendarDay(value) {
  if (!text(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value;
}
function time(value) {
  return calendarDay(value) || (text(value, 80) && calendarDay(value.slice(0,10)) &&
    /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
}
function evidence(item, activity) {
  check(item && time(item.occurredAt) && reference(item.id, 700));
  const record = {kind:item.kind, id:item.id, occurredAt:item.occurredAt};
  if (activity) { check(['conversation','noteCreated','noteEdited'].includes(item.kind)); return record; }
  check(['achievement','discussion','decision','version'].includes(item.kind) && text(item.title,180) &&
    ['file','thread'].includes(item.sourceKind) && ['open','decided','delivered','verified','withdrawn'].includes(item.resolution) &&
    (item.detail === null || text(item.detail,240)) && (item.kind === 'version' ? item.version : item.version === null));
  let version = null;
  if (item.version) {
    const v = item.version;
    check((v.product === null || text(v.product,180)) && text(v.number,80) && ['source','built','running'].includes(v.stage));
    version = {product:v.product, number:v.number, stage:v.stage};
  }
  return {...record, title:item.title, sourceKind:item.sourceKind, detail:item.detail, resolution:item.resolution, version};
}
function project(item) {
  check(item && reference(item.projectKey,300) && text(item.name,300) &&
    !/\\|[a-z]:\/|(?:^|[\s:=])\/\S|(?:^|:)(?:cwd|path|file):|%(?:25)*(?:2f|5c)|^[a-z]:$/i.test(item.name) && typeof item.archived === 'boolean');
  return {projectKey:item.projectKey, name:item.name, archived:item.archived};
}
function report(input, week) {
  const p = input?.period;
  check(input?.schemaVersion === 1 && p?.week === week && calendarDay(p.startDate) && calendarDay(p.endDate) &&
    new Date(p.startDate).getUTCDay() === 1 && Date.parse(p.endDate) - Date.parse(p.startDate) === 6 * 86400000 &&
    time(p.through) && p.through.length > 10 && text(p.timeZone,100));
  let dayFormat;
  try { dayFormat = new Intl.DateTimeFormat('en-CA', {timeZone:p.timeZone, year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch { throw new ReadError('invalid_response','周报没有提供有效的本地时区。'); }
  const dayOf = date => {
    const parts = Object.fromEntries(dayFormat.formatToParts(date).map(part => [part.type,part.value]));
    return [parts.year,parts.month,parts.day].join('-');
  };
  const through = Date.parse(p.through), throughDay = dayOf(through);
  check(throughDay >= p.startDate && throughDay <= p.endDate &&
    (week !== 'previous' || (throughDay === p.endDate && dayOf(through + 1) > p.endDate)));
  const inPeriod = (item, activity, earlier = false) => {
    const value = evidence(item,activity);
    const day = value.occurredAt.length === 10 ? value.occurredAt : dayOf(Date.parse(value.occurredAt));
    check(earlier ? day < p.startDate :
      day >= p.startDate && day <= throughDay && (value.occurredAt.length === 10 || Date.parse(value.occurredAt) <= through));
    return value;
  };
  const coverage = pickedCounts(input.coverage, ['registeredProjects','activeProjects','withoutDatedActivityThisWeek','demoProjectsExcluded','undatedMilestones']);
  check(Array.isArray(input.activeProjects) && input.activeProjects.length === coverage.activeProjects &&
    coverage.activeProjects + coverage.withoutDatedActivityThisWeek === coverage.registeredProjects &&
    Array.isArray(input.earlierProjects) && input.earlierProjects.length <= Math.min(2,coverage.withoutDatedActivityThisWeek));
  const activeProjects = input.activeProjects.map(item => {
    const identity = project(item);
    const counts = pickedCounts(item.counts, ['milestones','conversations','notesCreated','notesEdited']);
    check(Array.isArray(item.milestones) && item.milestones.length === Math.min(4,counts.milestones) && Array.isArray(item.activities) &&
      item.activities.length === Math.min(2,counts.conversations + counts.notesCreated + counts.notesEdited));
    return {...identity, counts, milestones:item.milestones.map(f => inPeriod(f, false)), activities:item.activities.map(a => inPeriod(a, true))};
  });
  const earlierProjects = input.earlierProjects.map(item => {
    const identity = project(item);
    check(!identity.archived && item.lastRecorded);
    return {...identity, lastRecorded:inPeriod(item.lastRecorded, ['conversation','noteCreated','noteEdited'].includes(item.lastRecorded.kind), true)};
  });
  check(new Set([...activeProjects,...earlierProjects].map(group => group.projectKey)).size === activeProjects.length + earlierProjects.length);
  return {schemaVersion:1, period:{week, startDate:p.startDate, endDate:p.endDate, through:p.through, timeZone:p.timeZone}, coverage, activeProjects, earlierProjects};
}

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { console.log(usage); return; }
  if (args.length && (args.length !== 2 || args[0] !== '--week' || !['previous','current'].includes(args[1]))) {
    throw new ReadError('invalid_arguments', usage);
  }
  const week = args[1] ?? 'previous', {url,store} = await binding();
  const health = await read(url, '/api/health', 128 * 1024);
  if (health?.ok !== true || health.dataStoreId !== store) throw new ReadError('wrong_board','服务与本机绑定的数据目录不一致，本次没有读到可信的周报。');
  if (health.capabilities?.weeklyReview !== true) throw new ReadError('unsupported_board','已连接的桌面版本尚未提供周报读取接口。');
  const input = await read(url, '/api/reviews/weekly?week=' + week, 8 * 1024 * 1024);
  if (input?.dataStoreId !== store) throw new ReadError('wrong_board','周报来源与本机绑定不一致，本次没有返回项目数据。');
  console.log(JSON.stringify(report(input,week)));
}
main(process.argv.slice(2)).catch(error => {
  const known = error instanceof ReadError;
  console.error(JSON.stringify({error:known ? error.code : 'read_failed', message:known ? error.message : '周报读取未完成。'})); process.exitCode = 1;
});
