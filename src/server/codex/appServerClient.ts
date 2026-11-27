import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { APP_VERSION } from '../../shared/version.js';
import { resolveCodexExecutable } from './summaryRuntime.js';
import { expandPastedRequests } from './pastedText.js';
import { checkCodexOperation, type CodexOperationGuard } from '../../shared/codexAccess.js';

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; cleanup(): void; operation?: CodexOperationGuard; onResult?(value: unknown): void }
interface TurnWaiter { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; text: string; cleanup(): void; operation?: CodexOperationGuard }
function operationError(operation?: CodexOperationGuard): Error {
  try { checkCodexOperation(operation); } catch (error) { return error instanceof Error ? error : new Error('Codex operation was cancelled.'); }
  return new Error('Codex operation was cancelled.');
}
const MAX_RESPONSE_BYTES = 16_000_000;
const MAX_TURN_PAGE_REQUESTS = 8;
type NativeTurn = Record<string, unknown>;
interface TurnPage { turns: NativeTurn[]; nextCursor: string | null; gap?: string }
class ResponseSizeError extends Error {
  readonly code = 'codex_response_too_large';
  constructor() { super('Codex reader response exceeds its memory limit.'); }
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private turns = new Map<string, TurnWaiter>();
  private initialized = false;
  private connecting: Promise<void> | null = null;
  private generation = 0;

  constructor(private readonly executable: string) {}

  async connect(operation?: CodexOperationGuard): Promise<void> {
    checkCodexOperation(operation);
    if (this.initialized) return;
    if (this.connecting) { await this.connecting; checkCodexOperation(operation); return; }
    const generation = this.generation;
    this.connecting = this.open(generation, operation).finally(() => { if (generation === this.generation) this.connecting = null; });
    await this.connecting; checkCodexOperation(operation);
  }

  private async open(generation: number, operation?: CodexOperationGuard): Promise<void> {
    const executable = await resolveCodexExecutable(this.executable);
    checkCodexOperation(operation);
    if (generation !== this.generation) throw new Error('Codex reader was closed.');
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], { stdio: 'pipe', windowsHide: true });
    this.child = child;
    const fail = (error: Error) => { if (this.child === child) { this.rejectAll(error); child.kill(); } };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Codex App Server exited with code ${code ?? 'unknown'}.`)));
    // Drain diagnostics without persisting potentially private log text.
    child.stderr.resume();
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    let parts: string[] = []; let frameBytes = 0;
    child.stdout.on('data', (chunk: string) => {
      if (this.child !== child) return;
      for (let from = 0; from < chunk.length;) {
        const newline = chunk.indexOf('\n', from);
        const part = newline < 0 ? chunk.slice(from) : chunk.slice(from, newline);
        frameBytes += Buffer.byteLength(part, 'utf8');
        if (frameBytes > MAX_RESPONSE_BYTES) { parts = []; fail(new ResponseSizeError()); return; }
        if (part) parts.push(part);
        if (newline < 0) return;
        this.receive(parts.join('')); parts = []; frameBytes = 0; from = newline + 1;
      }
    });
    try {
      await this.request('initialize', {
        clientInfo: { name: 'zz-board', title: 'ZZ 都要干什么', version: APP_VERSION },
        capabilities: { experimentalApi: true }
      }, 45_000, undefined, operation);
      checkCodexOperation(operation);
      if (this.child !== child || generation !== this.generation) throw new Error('Codex reader was closed.');
      this.notify('initialized', {});
      this.initialized = true;
    } catch (error) { fail(error instanceof Error ? error : new Error('Codex reader initialization failed.')); throw error; }
  }

  async request(method: string, params: unknown, timeoutMs = 15_000, onResult?: (value: unknown) => void, operation?: CodexOperationGuard): Promise<unknown> {
    checkCodexOperation(operation);
    if (!this.child) throw new Error('Codex App Server is not connected.');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id); cleanup();
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      const onAbort = () => { this.pending.delete(id); clearTimeout(timer); cleanup(); reject(operationError(operation)); };
      const cleanup = () => operation?.signal?.removeEventListener('abort', onAbort);
      operation?.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, onResult, cleanup, operation });
      this.child!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async listThreads(limit = 200, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    return this.request('thread/list', { limit, archived: false, sortKey: 'updated_at' }, undefined, undefined, operation);
  }

  async readThread(threadId: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    return this.request('thread/read', { threadId, includeTurns: true }, undefined, undefined, operation);
  }

  async readThreadMetadata(threadId: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    return this.request('thread/read', { threadId, includeTurns: false }, undefined, undefined, operation);
  }

  /** Explicit on-demand conversation page. Never resume or load an entire task. */
  async readConversationPage(threadId: string, cursor?: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    const metadata = asRecord(await this.request('thread/read', { threadId, includeTurns: false }, undefined, undefined, operation));
    checkCodexOperation(operation);
    const thread = asRecord(metadata.thread);
    if (thread.id !== threadId) throw new Error('Source identity mismatch.');
    const { turns, nextCursor, gap } = await this.readStoredTurnsPage(threadId, cursor, operation);
    const attachmentGaps = await expandPastedRequests(turns, undefined, operation);
    checkCodexOperation(operation);
    return { thread: { ...thread, turns: turns.toReversed() }, conversationRead: { nextCursor, attachmentGaps, gap } };
  }

  /** One bounded page from the source itself. No file/attachment expansion. */
  async readStoredTurnsPage(threadId: string, cursor?: string, operation?: CodexOperationGuard): Promise<TurnPage> {
    return this.readTurnWindow(threadId, cursor, 20, operation);
  }

  private async readTurnWindow(threadId: string, start: string | undefined, capacity: number, operation?: CodexOperationGuard, byteBudget = MAX_RESPONSE_BYTES): Promise<TurnPage> {
    const generation = this.generation;
    const turns: NativeTurn[] = [];
    const ids = new Set<string>(); const cursors = new Set(start ? [start] : []);
    let cursor = start; let limit = capacity; let subdivided = false;
    for (let attempt = 0; attempt < MAX_TURN_PAGE_REQUESTS; attempt++) {
      checkCodexOperation(operation);
      if (generation !== this.generation) throw new Error('Codex reader was closed.');
      await this.connect(operation); checkCodexOperation(operation);
      const count = Math.min(limit, capacity - turns.length);
      let result;
      try {
        result = asRecord(await this.request('thread/turns/list', { threadId, limit: count, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) }, undefined, undefined, operation));
      } catch (error) {
        checkCodexOperation(operation);
        if (!(error instanceof ResponseSizeError)) throw error;
        if (count === 1) {
          if (turns.length) return { turns, nextCursor: cursor!, gap: '有一个更早的回合超过单次读取上限，已保留此前读到的内容。' };
          throw Object.assign(new Error('A single stored turn exceeds the reader limit.'), { code: 'turn_exceeds_read_limit' });
        }
        limit = count > 6 ? 6 : count > 3 ? 3 : 1;
        subdivided = true;
        continue; // The oversized frame closed its child. Reconnect at exactly this cursor.
      }
      checkCodexOperation(operation);
      if (!Array.isArray(result.data) || result.data.length > count) throw new Error('Invalid conversation page.');
      const next = result.nextCursor;
      if (next != null && (typeof next !== 'string' || !next || cursors.has(next) || !result.data.length)) throw new Error('Invalid conversation cursor.');
      const page = result.data.map(asRecord);
      for (const turn of page) {
        if (typeof turn.id !== 'string' || !turn.id || ids.has(turn.id)) throw new Error('Invalid conversation turn identity.');
        ids.add(turn.id);
      }
      const retained = page.map(readableTurn);
      const size = Buffer.byteLength(JSON.stringify(retained));
      if (size > byteBudget) return { turns, nextCursor: cursor ?? null, gap: '本次可读正文已达到大小上限。' };
      byteBudget -= size;
      turns.push(...retained);
      if (typeof next !== 'string' || !subdivided || turns.length === capacity) return { turns, nextCursor: typeof next === 'string' ? next : null };
      cursor = next; cursors.add(next);
    }
    return { turns, nextCursor: cursor ?? null, gap: '本次已达到分页读取次数上限，较早内容留待下次。' };
  }

  /** Read stored history without loading/resuming the source task. The paging
   * API is experimental: unsupported runtimes fail rather than read all history. */
  async readRecentThread(threadId: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    try {
      const metadata = asRecord(await this.request('thread/read', { threadId, includeTurns: false }, undefined, undefined, operation));
      checkCodexOperation(operation);
      const thread = asRecord(metadata.thread);
      if (thread.id !== threadId) throw new Error('Source identity mismatch.');
      const descending: Record<string, unknown>[] = [];
      const ids = new Set<string>();
      let cursor: string | null = null; let pages = 0; let gap: string | undefined;
      let byteBudget = MAX_RESPONSE_BYTES;
      for (let page = 0; page < 2; page++) {
        checkCodexOperation(operation);
        const result = await this.readTurnWindow(threadId, cursor ?? undefined, 6, operation, byteBudget);
        byteBudget -= Buffer.byteLength(JSON.stringify(result.turns));
        for (const turn of result.turns) {
          const id = String(turn.id);
          if (!ids.has(id)) { ids.add(id); descending.push(turn); }
        }
        pages++;
        cursor = result.nextCursor; gap = result.gap;
        // Most clicks need only six turns. Fetch one older page only when the
        // recent page has too little user/final-answer evidence for context.
        const relevant = descending.flatMap(turn => Array.isArray(turn.items) ? turn.items.map(asRecord) : [])
          .filter(item => item.type === 'userMessage' || item.type === 'agentMessage' && (item.phase == null || item.phase === 'final_answer')).length;
        if (gap || !cursor || relevant >= 2) break;
      }
      const attachmentGaps = await expandPastedRequests(descending, undefined, operation);
      checkCodexOperation(operation);
      return { thread: { ...thread, turns: descending.toReversed() }, recentRead: { pages, truncated: cursor !== null, nextCursor: cursor, gap, ...(attachmentGaps.length ? { attachmentGaps } : {}) } };
    } catch (cause) {
      checkCodexOperation(operation);
      if (cause instanceof ResponseSizeError || asRecord(cause).code === 'turn_exceeds_read_limit') throw cause;
      if (cause instanceof Error && /^(thread\/read|thread\/turns\/list) timed out\.$/.test(cause.message)) throw cause;
      const error = new Error('本机 Codex 有界回合分页读取不可用；未回退读取完整历史。');
      Object.assign(error, { code: 'recent_paging_unavailable' });
      throw error;
    }
  }

  async listProjectThreads(cwd: string, cursor?: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    return this.request('thread/list', {
      cwd, cursor: cursor ?? null, limit: 50, archived: false, sortKey: 'updated_at',
      sourceKinds: ['cli', 'vscode', 'appServer'], useStateDbOnly: true
    }, undefined, undefined, operation);
  }

  async sendCuratorTurn(threadId: string, prompt: string, operation?: CodexOperationGuard): Promise<unknown> {
    await this.connect(operation); checkCodexOperation(operation);
    await this.request('thread/resume', { threadId }, undefined, undefined, operation);
    checkCodexOperation(operation);
    return new Promise((resolve, reject) => {
      void this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly' },
        outputSchema: {
          type: 'object', additionalProperties: false,
          required: ['kind', 'answer', 'relatedThreadKeys', 'reason', 'targetThreadKey', 'draft'],
          properties: {
            kind: { enum: ['answer', 'handoff'] }, answer: { type: ['string', 'null'] },
            relatedThreadKeys: { type: 'array', maxItems: 20, items: { type: 'string' } },
            reason: { type: ['string', 'null'] }, targetThreadKey: { type: ['string', 'null'] }, draft: { type: ['string', 'null'] }
          }
        }
      }, 60_000, started => {
        checkCodexOperation(operation);
        // Install synchronously while handling the RPC response, before the next
        // notification in the same stdout chunk can be dispatched.
        const turnId = turnIdFromTurn(asRecord(started).turn);
        if (!turnId) throw new Error('Codex App Server did not return a turn id.');
        const timer = setTimeout(() => { this.turns.delete(turnId); cleanup(); reject(new Error('Curator turn timed out.')); }, 120_000);
        const onAbort = () => { this.turns.delete(turnId); clearTimeout(timer); cleanup(); reject(operationError(operation)); };
        const cleanup = () => operation?.signal?.removeEventListener('abort', onAbort);
        operation?.signal?.addEventListener('abort', onAbort, { once: true });
        this.turns.set(turnId, { resolve, reject, timer, text: '', cleanup, operation });
      }, operation).catch(reject);
    });
  }

  dispose(): void {
    const child = this.child;
    this.generation++;
    this.connecting = null;
    this.rejectAll(new Error('Codex reader was closed.'));
    child?.kill();
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  private receive(line: string): void {
    let message: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(line) as typeof message; } catch { return; }
    if (message.method && message.params) { this.receiveNotification(message.method, message.params); return; }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    pending.cleanup();
    if (message.error) pending.reject(new Error(message.error.message || 'Codex App Server request failed.'));
    else {
      try { checkCodexOperation(pending.operation); pending.onResult?.(message.result); pending.resolve(message.result); }
      catch (error) { pending.reject(error instanceof Error ? error : new Error('Codex response could not be accepted.')); }
    }
  }

  private rejectAll(error: Error): void {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error); }
    this.pending.clear();
    for (const item of this.turns.values()) { clearTimeout(item.timer); item.cleanup(); item.reject(error); }
    this.turns.clear();
    this.child = null;
    this.initialized = false;
  }

  private receiveNotification(method: string, params: Record<string, unknown>): void {
    const turnId = typeof params.turnId === 'string' ? params.turnId : turnIdFromTurn(params.turn);
    if (!turnId) return;
    const waiter = this.turns.get(turnId);
    if (!waiter) return;
    try { checkCodexOperation(waiter.operation); }
    catch (error) { clearTimeout(waiter.timer); waiter.cleanup(); this.turns.delete(turnId); waiter.reject(error instanceof Error ? error : new Error('Codex operation was cancelled.')); return; }
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') waiter.text += params.delta;
    if (method === 'item/completed') {
      const text = agentText(params.item);
      if (text) waiter.text = text;
    }
    if (method !== 'turn/completed') return;
    clearTimeout(waiter.timer);
    waiter.cleanup();
    this.turns.delete(turnId);
    const status = statusFromTurn(params.turn);
    if (status === 'failed' || status === 'interrupted') {
      waiter.reject(new Error(`Curator turn ${status}.`));
      return;
    }
    try { waiter.resolve(parseStructuredText(waiter.text)); }
    catch (error) { waiter.reject(error instanceof Error ? error : new Error(String(error))); }
  }
}

function turnIdFromTurn(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' ? (value as { id: string }).id : undefined;
}
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Consumers use original user text and final replies. Keep other item identities
 * for ambiguity checks, but never carry tool output, media or reasoning between pages. */
function readableTurn(turn: NativeTurn): NativeTurn {
  const items = Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
  const lastAssistant = items.findLast(item => item.type === 'agentMessage');
  return { id: turn.id, status: turn.status, startedAt: turn.startedAt, started_at: turn.started_at, completedAt: turn.completedAt, completed_at: turn.completed_at,
    items: items.map(item => {
      const user = item.type === 'userMessage';
      const final = item.type === 'agentMessage' && (item.phase === 'final_answer' || item.phase == null && item === lastAssistant && turn.status === 'completed');
      if (!user && !final) return { id: item.id };
      const content = user && Array.isArray(item.content) ? item.content.map(asRecord).filter(part => part.type === 'text').map(part => ({ type: 'text', text: part.text })) : undefined;
      return { id: item.id, type: item.type, phase: item.phase, text: item.text, content, createdAt: item.createdAt, created_at: item.created_at, timestamp: item.timestamp };
    })
  };
}
function statusFromTurn(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { status?: unknown }).status === 'string' ? (value as { status: string }).status : undefined;
}
function agentText(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as { type?: unknown; text?: unknown; content?: unknown };
  if (item.type !== 'agentMessage') return undefined;
  if (typeof item.text === 'string') return item.text;
  return typeof item.content === 'string' ? item.content : undefined;
}
function parseStructuredText(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!trimmed) throw new Error('Curator completed without a structured answer.');
  try { return JSON.parse(trimmed); } catch { throw new Error('Curator returned an invalid structured answer.'); }
}
