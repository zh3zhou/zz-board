import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { PassThrough } from 'node:stream';
type Rpc = { id: number; method: string; params: Record<string, unknown> };
const processFixture = vi.hoisted(() => ({ child: null as unknown as ChildProcessWithoutNullStreams, spawns: 0, requests: [] as Rpc[], answer: true,
  response: null as ((request: Rpc) => unknown) | null }));
vi.mock('node:child_process', async () => {
  const original = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  const { EventEmitter } = await import('node:events'); const { PassThrough } = await import('node:stream');
  return { ...original, spawn: () => {
    processFixture.spawns++;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
    child.stdin.on('data', (chunk: Buffer) => {
      const message = JSON.parse(chunk.toString());
      if (message.id == null) return;
      processFixture.requests.push(message);
      if (processFixture.answer) queueMicrotask(() => {
        const result = processFixture.response ? processFixture.response(message) : message.method === 'thread/list' ? { data: [], nextCursor: null } : {};
        if (result === 'oversized-fixture') {
          const block = 'x'.repeat(1_000_000);
          for (let i = 0; i < 16; i++) child.stdout.write(block);
          child.stdout.write('x'); return;
        }
        child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
      });
    });
    processFixture.child = child as unknown as ChildProcessWithoutNullStreams;
    return child;
  } };
});
import { CodexAppServerClient } from '../../src/server/codex/appServerClient.js';
import { cleanEvidenceText, extractRefreshEvidence, isLocalCodex, sourceTimestamp, type RefreshCandidate } from '../../src/server/projectRefresh.js';
import { sourceFingerprint } from '../../src/server/summaryJobs.js';
import { extractConversationTurns } from '../../src/server/conversationEvidence.js';

const stamp = '2026-09-21T08:00:00.000Z';
const project = { projectKey: 'saved-project', name: '合成项目', cwd: 'E:\\synthetic', observedAt: stamp, sidebarIndex: 7 };
const candidate: RefreshCandidate = { threadKey: 'legacy:one', threadId: 'one', title: '原始标题', hostId: null, sourceUpdatedAt: stamp, sidebarIndex: 9 };
const turn = (id = 'turn', patch: Record<string, unknown> = {}) => ({ id, status: 'completed', startedAt: stamp, completedAt: stamp,
  items: [{ id: 'request', type: 'userMessage', content: [{ type: 'text', text: '请完成修改。' }] }, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '修改已完成，尚未测试。' }], ...patch });
const payload = (turns = [turn()], patch = {}) => ({ thread: { id: 'one', cwd: project.cwd, updatedAt: stamp, status: { type: 'notLoaded' }, turns, ...patch } });

describe('bounded project refresh extraction', () => {
  it('keeps original identity/order and true event dates without treating notLoaded as idle', () => {
    const result = extractRefreshEvidence(payload(), candidate, project, '2026-09-21T09:00:00.000Z');
    expect(result.source).toMatchObject({ threadKey: 'legacy:one', hostId: null, sidebarIndex: 9, runtimeState: 'unknown', sourceUpdatedAt: stamp, readComplete: false });
    expect(result.source?.evidence).toHaveLength(2);
    expect(result.source?.evidence[0]).toMatchObject({ id: 'turn:request', occurredAt: stamp, role: 'user' });
  });
  it('excludes tool output, reasoning, commentary, images, and environment blocks', () => {
    // Runtime-only synthetic credential; no real credential or scanner exemption.
    const syntheticCredential = ['sk', 'test', 'secret', 'key', '0123456789'].join('-');
    const input = payload([turn('turn', { items: [
      { type: 'reasoning', id: 'reason', text: 'NEVER_INCLUDE_REASONING' },
      { type: 'commandExecution', id: 'command', aggregatedOutput: 'NEVER_INCLUDE_OUTPUT' },
      { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'NEVER_INCLUDE_COMMENTARY' },
      { type: 'userMessage', id: 'request', content: [{ type: 'image', url: 'NEVER_INCLUDE_IMAGE' }, { type: 'text', text: `<environment_context>PRIVATE_ENV</environment_context>\n请核对结果。\napi_key=${syntheticCredential}` }] },
      { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '已完成报告。' }
    ] })]);
    const encoded = JSON.stringify(extractRefreshEvidence(input, candidate, project, stamp));
    expect(encoded).not.toMatch(/NEVER_INCLUDE|PRIVATE_ENV|sk-test/);
    expect(encoded).not.toContain(syntheticCredential);
    expect(encoded).toContain('请核对结果'); expect(encoded).toContain('疑似凭据已移除');
  });
  it('retains dated evidence before empty interrupted tails without inventing freshness', () => {
    const later = '2026-09-22T08:00:00.000Z';
    const result = extractRefreshEvidence(payload([turn(), turn('new', { items: [], status: 'interrupted', startedAt: later, completedAt: later })], { updatedAt: later }), candidate, project, later);
    expect(result.source?.evidence).toHaveLength(2);
    expect(result.source?.evidence.every(e => e.occurredAt === stamp)).toBe(true);
    expect(result.source?.sourceUpdatedAt).toBe(later);
    expect(result.source?.readReason).toContain('最新回合没有可用');
    expect(result.gaps.join('')).toContain('不能据此判断');
    expect(result.latestTurnNotice).toContain('中断');
    expect(result.source?.readReason).not.toContain('中断'); // previous text cannot be cited for the empty tail
  });
  it('drops only undated items, not the whole source, and never dates them from thread metadata', () => {
    expect(extractRefreshEvidence(payload([turn('new', { startedAt: undefined, completedAt: undefined })]), candidate, project, stamp).source).toBeNull();
    const mixed = extractRefreshEvidence(payload([turn('new', { completedAt: undefined })]), candidate, project, stamp);
    expect(mixed.source?.evidence.map(e => e.role)).toEqual(['user']);
    expect(mixed.gaps.join('')).toContain('部分条目缺少真实时间');
  });
  it('accepts a request-only latest turn without fabricating assistant delivery', () => {
    const result = extractRefreshEvidence(payload([turn('new', { status: 'inProgress', completedAt: null, items: [{ type: 'userMessage', id: 'request', content: [{ type: 'text', text: '开始新步骤。' }] }] })]), candidate, project, stamp);
    expect(result.source?.evidence.map(e => e.role)).toEqual(['user']);
  });
  it('distinguishes a saved interruption, failure and unfinished request without promoting any to a live signal', () => {
    const hashes = new Set<string>(), turnHashes = new Set<string>();
    for (const [status, word] of [['inProgress','未结束'],['interrupted','中断'],['failed','失败']] as const) {
      const input = payload([turn('delivered'),turn('retry', {status,items:[{type:'userMessage',id:'request',text:'请再做一次。'}]})],
        {status:{type:'active'}});
      const source = extractRefreshEvidence(input,candidate,project,stamp).source!;
      expect(source.runtimeState).toBe('unknown');
      expect(source.readReason).toContain(word);
      expect(source.requestOnlyTurnId).toBe('retry');
      expect(extractRefreshEvidence(input,candidate,project,stamp).gaps.join('')).not.toContain(word);
      expect(source.evidence.map(e=>e.id)).toEqual(['delivered:request','delivered:answer','retry:request']);
      hashes.add(sourceFingerprint(source));
      expect(sourceFingerprint(extractRefreshEvidence(input,candidate,project,'2026-10-01T00:00:00Z').source!)).toBe(sourceFingerprint(source));
      const history = extractConversationTurns(input,'one').turns;
      expect(history[1]?.recordedTurnNotice).toContain(word);
      expect(history[0]?.recordedTurnNotice).toBeUndefined();
      expect(history[1]?.gaps.join('')).not.toContain(word);
      turnHashes.add(history[1]!.fingerprint);
    }
    expect([hashes.size,turnHashes.size]).toEqual([3,3]);
  });
  it('bounds turns, each excerpt, and total characters while preserving the newest reply', () => {
    const many = Array.from({ length: 40 }, (_, i) => turn(`turn-${i}`, { items: [{ id: 'answer', type: 'agentMessage', phase: 'final_answer', text: `正文${i}` + '字'.repeat(17000) }] }));
    const extracted = extractRefreshEvidence(payload(many), candidate, project, stamp);
    const result = extracted.source!;
    expect(result.evidence.length).toBeLessThanOrEqual(6);
    expect(result.evidence.at(-1)?.id).toBe('turn-39:answer');
    expect(result.evidence.every(e => e.text.length <= 7000)).toBe(true);
    expect(result.evidence.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(60000);
    expect(result.readReason).toContain('正文超出预算已截取'); expect(extracted.gaps.join('')).toContain('不覆盖全部文字');
  });
  it('keeps unchanged content cacheable across check times', () => {
    const first = extractRefreshEvidence(payload(), candidate, project, stamp).source!;
    const second = extractRefreshEvidence(payload(), candidate, project, '2026-09-22T08:00:00.000Z').source!;
    expect(sourceFingerprint(first)).toBe(sourceFingerprint(second));
  });
  it('fails identity/cwd mismatch and never classifies remote or ChatGPT as local', () => {
    expect(extractRefreshEvidence(payload([turn()], { id: 'another' }), candidate, project, stamp).source).toBeNull();
    expect(extractRefreshEvidence(payload([turn()], { cwd: 'E:\\other' }), candidate, project, stamp).source).toBeNull();
    expect(isLocalCodex({ sourceKind: 'chatgpt', hostId: 'local' })).toBe(false);
    expect(isLocalCodex({ sourceKind: 'codex', hostId: 'remote:host' })).toBe(false);
    expect(isLocalCodex({ sourceKind: 'codex' })).toBe(true);
  });
  it('rejects invalid/undated timestamps and strips attachment-only instructions', () => {
    expect(sourceTimestamp(Number.NaN)).toBeUndefined(); expect(sourceTimestamp('yesterday')).toBeUndefined();
    expect(sourceTimestamp('2026-09-21')).toBeUndefined(); expect(sourceTimestamp(1789977600)).toBe(stamp);
    expect(cleanEvidenceText('# AGENTS.md instructions for E:\\synthetic\nDo something')).toBe('');
    expect(cleanEvidenceText('![](attachment.png)\n## My request:\n请更新。')).toBe('请更新。');
  });
});

describe('read-only app-server reader lifecycle', () => {
  beforeEach(() => { processFixture.spawns = 0; processFixture.requests = []; processFixture.answer = true; processFixture.response = null; });
  afterEach(() => { processFixture.child?.stdin.destroy(); processFixture.child?.stdout.destroy(); processFixture.child?.stderr.destroy(); vi.useRealTimers(); });
  const client = () => new CodexAppServerClient(process.platform === 'win32' ? 'E:\\synthetic\\codex.exe' : '/synthetic/codex');
  it.each(['recent', 'conversation'] as const)('stops %s paging after revocation during metadata', async kind => {
    const reader = client(); vi.spyOn(reader, 'connect').mockResolvedValue();
    let permitted = true; let release!: (value: unknown) => void;
    const request = vi.spyOn(reader, 'request').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const operation = { check: () => { if (!permitted) throw Object.assign(new Error('Synthetic access revoked.'), { code: 'CODEX_ACCESS_REQUIRED' }); } };
    const reading = (kind === 'recent' ? reader.readRecentThread('one', operation) : reader.readConversationPage('one', undefined, operation)).catch(error => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1)); permitted = false; release({ thread: { id: 'one' } });
    expect(await reading).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' });
    expect(request.mock.calls.map(call => call[0])).toEqual(['thread/read']); reader.dispose();
  });
  it('does not request an older page after revocation during the first bounded page', async () => {
    const reader = client(); vi.spyOn(reader, 'connect').mockResolvedValue(); let permitted = true; let release!: (value: unknown) => void;
    const request = vi.spyOn(reader, 'request').mockResolvedValueOnce({ thread: { id: 'one' } })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const operation = { check: () => { if (!permitted) throw Object.assign(new Error('Synthetic access revoked.'), { code: 'CODEX_ACCESS_REQUIRED' }); } };
    const reading = reader.readRecentThread('one', operation).catch(error => error);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2)); permitted = false;
    release({ data: [turn('latest', { items: [] })], nextCursor: 'older' });
    expect(await reading).toMatchObject({ code: 'CODEX_ACCESS_REQUIRED' }); expect(request).toHaveBeenCalledTimes(2); reader.dispose();
  });
  it('coalesces connection initialization and only sends read-only collection calls', async () => {
    const reader = client();
    await Promise.all([reader.listProjectThreads(project.cwd), reader.readThread('one')]);
    expect(processFixture.spawns).toBe(1);
    expect(processFixture.requests.map(request => request.method)).toEqual(['initialize', 'thread/list', 'thread/read']);
    expect(processFixture.requests[1]?.params).toMatchObject({ cwd: project.cwd, limit: 50, useStateDbOnly: true, archived: false, sourceKinds: ['cli', 'vscode', 'appServer'] });
    expect(processFixture.requests[2]?.params).toEqual({ threadId: 'one', includeTurns: true });
    reader.dispose(); expect(processFixture.child.kill).toHaveBeenCalledTimes(1);
  });
  it('disposes its child and rejects pending work on bounded initialization timeout', async () => {
    vi.useFakeTimers(); processFixture.answer = false; const reader = client();
    const opening = reader.connect().catch(error => error);
    await vi.advanceTimersByTimeAsync(45_001);
    expect((await opening).message).toContain('timed out'); expect(processFixture.child.kill).toHaveBeenCalledTimes(1);
    reader.dispose();
  });
  it('rejects pending read on dispose and drains diagnostics without storing their text', async () => {
    const reader = client(); await reader.connect(); processFixture.answer = false;
    const reading = reader.readThread('one').catch(error => error);
    await Promise.resolve(); (processFixture.child.stderr as PassThrough).write('synthetic diagnostic');
    reader.dispose(); expect(await reading).toMatchObject({ message: expect.stringContaining('closed') });
  });
  it('reads metadata plus newest-first six-turn pages and returns oldest-first evidence', async () => {
    const reader = client(); vi.spyOn(reader, 'connect').mockResolvedValue();
    const recent = Array.from({ length: 6 }, (_, i) => turn(`t-${12 - i}`));
    const request = vi.spyOn(reader, 'request').mockImplementation(async method => method === 'thread/read'
      ? { thread: { id: 'one', updatedAt: stamp, turns: [{ id: 'unwanted-metadata-turn' }] } }
      : { data: recent, nextCursor: 'older', backwardsCursor: null });
    const result = await reader.readRecentThread('one') as { thread: { turns: Array<{ id: string }> }; recentRead: { pages: number } };
    expect(request.mock.calls.map(call => [call[0], call[1]])).toEqual([
      ['thread/read', { threadId: 'one', includeTurns: false }],
      ['thread/turns/list', { threadId: 'one', limit: 6, sortDirection: 'desc', itemsView: 'full' }]
    ]);
    expect(result.thread.turns.map(t => t.id)).toEqual(['t-7', 't-8', 't-9', 't-10', 't-11', 't-12']);
    expect(result.recentRead.pages).toBe(1);
  });
  it('uses nextCursor for at most one older page when recent evidence is sparse', async () => {
    const reader = client(); vi.spyOn(reader, 'connect').mockResolvedValue();
    const request = vi.spyOn(reader, 'request').mockResolvedValueOnce({ thread: { id: 'one', updatedAt: stamp } })
      .mockResolvedValueOnce({ data: [turn('latest', { items: [] })], nextCursor: 'older', backwardsCursor: 'newer' })
      .mockResolvedValueOnce({ data: [turn('previous')], nextCursor: 'even-older', backwardsCursor: null });
    const result = await reader.readRecentThread('one') as { thread: { turns: Array<{ id: string }> }; recentRead: { pages: number; truncated: boolean } };
    expect(request.mock.calls[2]?.[1]).toEqual({ threadId: 'one', limit: 6, sortDirection: 'desc', itemsView: 'full', cursor: 'older' });
    expect(result.thread.turns.map(t => t.id)).toEqual(['previous', 'latest']);
    expect(result.recentRead).toEqual({ pages: 2, truncated: true, nextCursor: 'even-older' }); expect(request).toHaveBeenCalledTimes(3);
    expect(extractRefreshEvidence(result, candidate, project, stamp).source?.evidence).toHaveLength(2);
  });
  it('never falls back to full-history reads when paging is unsupported', async () => {
    const reader = client(); vi.spyOn(reader, 'connect').mockResolvedValue();
    const request = vi.spyOn(reader, 'request').mockResolvedValueOnce({ thread: { id: 'one' } }).mockRejectedValueOnce(new Error('method unsupported'));
    await expect(reader.readRecentThread('one')).rejects.toMatchObject({ code: 'recent_paging_unavailable' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.some(call => (call[1] as { includeTurns?: boolean }).includeTurns === true)).toBe(false);
  });
  it('reads exactly twenty on-demand conversation turns with an explicit older cursor, never resumes tasks', async () => {
    const reader=client();vi.spyOn(reader,'connect').mockResolvedValue();
    const request=vi.spyOn(reader,'request').mockResolvedValueOnce({thread:{id:'one',updatedAt:stamp}})
      .mockResolvedValueOnce({data:Array.from({length:20},(_,i)=>turn(`t-${20-i}`)),nextCursor:'next'});
    const result=await reader.readConversationPage('one','previous') as {thread:{turns:Array<{id:string}>};conversationRead:{nextCursor:string}};
    expect(request.mock.calls.map(c=>[c[0],c[1]])).toEqual([
      ['thread/read',{threadId:'one',includeTurns:false}],['thread/turns/list',{threadId:'one',limit:20,sortDirection:'desc',itemsView:'full',cursor:'previous'}]
    ]);
    expect(result.thread.turns[0]!.id).toBe('t-1');expect(result.thread.turns.at(-1)!.id).toBe('t-20');expect(result.conversationRead.nextCursor).toBe('next');
  });
  it('reconnects at the exact cursor, fills a heavy twenty-turn window and discards tool payloads', async () => {
    const reader = client();
    processFixture.response = ({ method, params }) => {
      if (method === 'thread/read') return { thread: { id: 'one', updatedAt: stamp } };
      if (method !== 'thread/turns/list') return {};
      const limit = Number(params.limit), newest = Number(String(params.cursor).slice(1));
      if (limit === 20 || newest === 14 && limit === 6) return 'oversized-fixture';
      const data = Array.from({ length: limit }, (_, i) => {
        const t = turn('t' + (newest-i));
        return { ...t, items: [...t.items, { type: 'commandExecution', id: 'cmd', aggregatedOutput: 'synthetic discarded output' }] };
      });
      return { data, nextCursor: 'c' + (newest-limit) };
    };
    try {
      const value = await reader.readConversationPage('one','c20') as { thread: { turns: NativeTestTurn[] }; conversationRead: { nextCursor: string; gap?: string } };
      expect(value.thread.turns.map(t => t.id)).toEqual(Array.from({length:20},(_,i)=>'t'+(i+1)));
      expect(value.conversationRead).toMatchObject({nextCursor:'c0'}); expect(value.conversationRead.gap).toBeUndefined();
      expect(JSON.stringify(value)).not.toContain('discarded output');
      expect(processFixture.spawns).toBe(3);
      expect(processFixture.requests.filter(r=>r.method==='thread/turns/list').map(r=>[r.params.cursor,r.params.limit])).toEqual([
        ['c20',20],['c20',6],['c14',6],['c14',3],['c11',3],['c8',3],['c5',3],['c2',2]]);
      expect(processFixture.requests.some(r=>r.params.includeTurns===true || r.method==='thread/resume')).toBe(false);
    } finally { reader.dispose(); }
  });
  it('uses the same size recovery for six-turn checks and never calls a model or requests full history', async () => {
    const reader = client();
    processFixture.response = ({method,params}) => {
      if (method==='thread/read') return {thread:{id:'one'}};
      if (method!=='thread/turns/list') return {};
      if (params.limit===6) return 'oversized-fixture';
      const start=params.cursor ? 3 : 6;
      return {data:Array.from({length:3},(_,i)=>turn('t'+(start-i))),nextCursor:params.cursor ? 'c0' : 'c3'};
    };
    try {
      const value = await reader.readRecentThread('one') as {thread:{turns:NativeTestTurn[]};recentRead:{nextCursor:string}};
      expect(value.thread.turns.map(t=>t.id)).toEqual(['t1','t2','t3','t4','t5','t6']); expect(value.recentRead.nextCursor).toBe('c0');
      expect(processFixture.requests.filter(r=>r.method==='thread/turns/list').map(r=>r.params.limit)).toEqual([6,3,3]);
    } finally { reader.dispose(); }
  });
  it('rejects an indivisible single turn, limits retries and leaves the transport reusable', async () => {
    const reader=client();
    processFixture.response=({method})=>method==='thread/turns/list'?'oversized-fixture':{};
    try {
      await expect(reader.readStoredTurnsPage('one','same')).rejects.toMatchObject({code:'turn_exceeds_read_limit'});
      expect(processFixture.requests.filter(r=>r.method==='thread/turns/list').map(r=>[r.params.cursor,r.params.limit])).toEqual([['same',20],['same',6],['same',3],['same',1]]);
      processFixture.response=({method})=>method==='thread/turns/list'?{data:[turn('small')],nextCursor:null}:{};
      expect((await reader.readStoredTurnsPage('two')).turns[0]?.id).toBe('small');
    } finally { reader.dispose(); }
  });
  it('returns the first unread native cursor and a coverage note when smaller reads reach the fixed request budget', async () => {
    const reader = client();
    processFixture.response = ({method,params}) => {
      if (method==='thread/read') return {thread:{id:'one',updatedAt:stamp,cwd:project.cwd}};
      if (method!=='thread/turns/list') return {};
      if (Number(params.limit)>1) return 'oversized-fixture';
      const start=Number(String(params.cursor).slice(1));
      return {data:[turn('t'+start)],nextCursor:'c'+(start+1)};
    };
    try {
      const result=await reader.readConversationPage('one','c0');
      const extracted=extractConversationTurns(result,'one');
      expect(extracted.nextCursor).toBe('c5'); expect(extracted.turns).toHaveLength(5);
      expect(extracted.gaps.join(' ')).toContain('分页读取次数上限');
      expect(extractRefreshEvidence(result,candidate,project,stamp).gaps.join(' ')).toContain('分页读取次数上限');
      expect(processFixture.requests.filter(r=>r.method==='thread/turns/list')).toHaveLength(8);
    } finally { reader.dispose(); }
  });
  it('does not resize or reconnect for an ordinary RPC failure whose text merely mentions size', async () => {
    const reader=client(); vi.spyOn(reader,'connect').mockResolvedValue();
    const request=vi.spyOn(reader,'request').mockRejectedValue(new Error('external RPC reported a memory limit'));
    await expect(reader.readStoredTurnsPage('one')).rejects.toThrow('external RPC');
    expect(request).toHaveBeenCalledTimes(1); reader.dispose();
  });
  it('aborts before reopening an oversized read after permission has been revoked', async () => {
    const reader=client(); let allowed=true;
    processFixture.response=({method})=>{if(method!=='thread/turns/list')return {}; allowed=false; return 'oversized-fixture';};
    const guard = {check() { if (!allowed) throw Object.assign(new Error('synthetic revoke'),{code:'CODEX_ACCESS_REQUIRED'}); }};
    try {
      await expect(reader.readStoredTurnsPage('one',undefined,guard)).rejects.toMatchObject({code:'CODEX_ACCESS_REQUIRED'});
      expect(processFixture.spawns).toBe(1); expect(processFixture.requests.filter(r=>r.method==='thread/turns/list')).toHaveLength(1);
    } finally { reader.dispose(); }
  });
  it.each(['cursor','turn'] as const)('rejects a repeated %s across smaller physical pages', async mode => {
    const reader=client();
    processFixture.response=({method,params})=>{
      if(method!=='thread/turns/list')return {};
      if(params.limit===20)return 'oversized-fixture';
      if(params.cursor==='a') return {data:[turn('first')],nextCursor:'b'};
      return {data:[turn(mode==='turn'?'first':'second')],nextCursor:mode==='cursor'?'a':'c'};
    };
    try {
      await expect(reader.readStoredTurnsPage('one','a')).rejects.toThrow('Invalid conversation');
      expect(processFixture.requests.filter(r=>r.method==='thread/turns/list')).toHaveLength(3);
    } finally { reader.dispose(); }
  });
});
type NativeTestTurn = { id: string };
