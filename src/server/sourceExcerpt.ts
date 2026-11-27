import { matchingProjectDirectory } from './projectDirectory.js';
import { checkCodexOperation, type CodexOperationGuard } from '../shared/codexAccess.js';
import { canLocateExcerpt, hasAbsoluteExcerptDirectory, type ExcerptSource, type SourceExcerptResult } from '../shared/sourceExcerpt.js';
import type { BoardDatabase } from './database.js';
import type { CodexAppServerClient } from './codex/appServerClient.js';
import { cleanEvidenceText } from './projectRefresh.js';

type Reader = Pick<CodexAppServerClient, 'readThreadMetadata' | 'readStoredTurnsPage'>;
type Stored = NonNullable<ReturnType<BoardDatabase['getExcerptSource']>>;
type Raw = Record<string, unknown>;
const record = (value: unknown): Raw => value !== null && typeof value === 'object' ? value as Raw : {};
const unavailable = (reason: 'scope' | 'window' | 'content' | 'read'): SourceExcerptResult => ({ status: 'unavailable', reason });

function identity({ project, thread, source }: Stored): string {
  return JSON.stringify([project.projectKey, project.hostId, project.projectId, project.cwd, thread.threadKey, thread.threadId, thread.hostId, source]);
}

function matchesNativeProject(project: Stored['project'], meta: Raw): boolean {
  const compareDirectory = Boolean(project.cwd && meta.cwd != null && meta.cwd !== '');
  const compareId = Boolean(project.projectId?.trim() && meta.projectId != null && meta.projectId !== '');
  if (compareDirectory && !matchingProjectDirectory(project.cwd!, meta.cwd)) return false;
  if (compareId && project.projectId !== meta.projectId) return false;
  return compareId || compareDirectory && hasAbsoluteExcerptDirectory(project.cwd);
}

function originalSpan(raw: string, cleaned: string): string | null {
  if (raw.includes(cleaned)) return cleaned;
  // The evidence cleaner normalizes line endings. Map a contiguous match back to the
  // original string so a Windows or mixed-line-ending message can be quoted verbatim.
  const start = raw.replace(/\r\n/g, '\n').indexOf(cleaned);
  if (start < 0) return null;
  const originalOffset = (normalizedOffset: number) => {
    let at = 0;
    for (let offset = 0; offset < normalizedOffset; offset++) at += raw.startsWith('\r\n', at) ? 2 : 1;
    return at;
  };
  return raw.slice(originalOffset(start), originalOffset(start + cleaned.length));
}

/** Only return one contiguous span of one original text field. Never quote a redaction or joined fields. */
function originalText(fields: unknown[]): SourceExcerptResult {
  for (const raw of fields) {
    if (typeof raw !== 'string' || raw.length > 200_000 || /-----BEGIN [^-]*PRIVATE KEY-----/.test(raw)) continue;
    const cleaned = cleanEvidenceText(raw);
    if (!cleaned || /\[(?:疑似凭据已移除|附件已省略)\]|<(?:environment_context|skills_instructions|send_user_message_question_reply|app-context|recommended_plugins)\b/i.test(cleaned)) continue;
    const span = originalSpan(raw, cleaned);
    if (span === null) continue;
    let length = 0, text = '';
    for (const char of span) {
      if (length === 360) break;
      text += char;
      length++;
    }
    return { status: 'found', text, partial: text !== raw || fields.length > 1 };
  }
  return unavailable('content');
}

function excerptFromTurn(turn: Raw, source: ExcerptSource): SourceExcerptResult {
  if (!Array.isArray(turn.items)) return unavailable('content');
  const items = turn.items.map(record);
  const matches = items.filter(item => typeof item.id === 'string' &&
    (source.id === `${turn.id}:${item.id}` || source.id === item.id));
  if (matches.length !== 1) return unavailable('content');
  const item = matches[0]!;
  if (source.role === 'user' && item.type === 'userMessage') {
    return originalText(Array.isArray(item.content) ? item.content.map(record).filter(part => part.type === 'text').map(part => part.text) : [item.text]);
  }
  const final = item.phase === 'final_answer' || item.phase == null && turn.status === 'completed' && items.findLast(i => i.type === 'agentMessage') === item;
  return source.role === 'assistant' && item.type === 'agentMessage' && final ? originalText([item.text]) : unavailable('content');
}

export async function readSourceExcerpt(db: BoardDatabase, reader: Reader, projectKey: string, threadKey: string, sourceId: string,
  consent: CodexOperationGuard, disconnected: AbortSignal): Promise<SourceExcerptResult> {
  const lookup = () => db.getExcerptSource(projectKey, threadKey, sourceId);
  const saved = lookup();
  if (!saved || !canLocateExcerpt(saved.project, saved.thread, saved.source)) return unavailable('scope');
  const expected = identity(saved);
  const scope = new AbortController();
  const unsubscribe = db.onMutation(() => {
    const current = lookup();
    if (!current || identity(current) !== expected) scope.abort();
  });
  const signals = [scope.signal, disconnected];
  if (consent.signal) signals.push(consent.signal);
  const operation = { check: () => checkCodexOperation(consent), signal: AbortSignal.any(signals) };
  try {
    checkCodexOperation(operation);
    const { threadId } = saved.thread;
    const meta = record(record(await reader.readThreadMetadata(threadId, operation)).thread);
    checkCodexOperation(operation);
    if (meta.id !== threadId || !matchesNativeProject(saved.project, meta)) return unavailable('scope');
    let cursor: string | undefined; let incomplete = false;
    for (let page = 0; page < 2; page++) {
      const { turns, nextCursor, gap } = await reader.readStoredTurnsPage(threadId, cursor, operation);
      if (gap) incomplete = true;
      checkCodexOperation(operation);
      if (turns.length > 20) return unavailable('read');
      const matches = turns.filter(turn => turn.id === saved.source.turnId);
      if (matches.length > 1) return unavailable('content');
      if (matches.length) return excerptFromTurn(matches[0]!, saved.source);
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return unavailable(incomplete ? 'read' : 'window');
  } catch {
    checkCodexOperation(consent);
    return unavailable(scope.signal.aborted ? 'scope' : 'read');
  } finally { unsubscribe(); }
}
