import { z } from 'zod';
import { feedbackDiagnosticsSchema, feedbackReceiptSchema, feedbackSubmissionSchema, FEEDBACK_RETRY_MS } from '../shared/feedback.js';
import type { FeedbackDiagnostics, FeedbackReceipt, FeedbackSubmission } from '../shared/feedback.js';

export type FeedbackFields = Pick<FeedbackSubmission, 'kind' | 'goal' | 'actual' | 'expected' | 'dataImpact' | 'contact'>;
export interface PreparedFeedback { submission: FeedbackSubmission; deleteToken: string }
export interface FeedbackDraft {
  schemaVersion: 1;
  fields: FeedbackFields;
  includeDiagnostics: boolean;
  diagnostics?: FeedbackDiagnostics;
  prepared?: PreparedFeedback;
}
export interface LocalFeedbackReceipt {
  schemaVersion: 1;
  reportId: string;
  deleteToken: string;
  createdAt: string;
  state: 'prepared' | 'uncertain' | 'received' | 'deleting' | 'deleted';
  receipt?: FeedbackReceipt;
}
export interface FeedbackState { draft: FeedbackDraft | null; receipts: LocalFeedbackReceipt[] }
export interface FeedbackPersistence {
  load(): Promise<FeedbackState>;
  saveDraft(draft: FeedbackDraft): Promise<void>;
  savePrepared(draft: FeedbackDraft & { prepared: PreparedFeedback }): Promise<void>;
  markUncertain(reportId: string): Promise<void>;
  markReceived(receipt: FeedbackReceipt): Promise<'received' | 'deleting' | 'deleted'>;
  markDeleting(reportId: string): Promise<void>;
  markDeleted(reportId: string): Promise<void>;
  clearDeletedReceipts(): Promise<void>;
}

const fieldsSchema = z.object({
  kind: z.enum(['problem', 'idea']), goal: z.string().max(4000), actual: z.string().max(8000), expected: z.string().max(4000),
  dataImpact: z.enum(['none', 'possible', 'unknown']), contact: z.string().max(300).optional()
}).strict();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const preparedSchema = z.object({ submission: feedbackSubmissionSchema, deleteToken: tokenSchema }).strict();
const draftSchema = z.object({
  schemaVersion: z.literal(1), fields: fieldsSchema, includeDiagnostics: z.boolean(),
  diagnostics: feedbackDiagnosticsSchema.optional(), prepared: preparedSchema.optional()
}).strict();
const localReceiptSchema = z.object({
  schemaVersion: z.literal(1), reportId: z.string().uuid(), deleteToken: tokenSchema,
  createdAt: z.string().datetime(), state: z.enum(['prepared', 'uncertain', 'received', 'deleting', 'deleted']),
  receipt: feedbackReceiptSchema.optional()
}).strict();
const stateSchema = z.object({ draft: draftSchema.nullable(), receipts: z.array(localReceiptSchema) }).strict();
const EMPTY_STATE: FeedbackState = { draft: null, receipts: [] };

export function emptyFeedbackDraft(): FeedbackDraft {
  return { schemaVersion: 1, fields: { kind: 'problem', goal: '', actual: '', expected: '', dataImpact: 'unknown', contact: '' }, includeDiagnostics: false };
}

export function parseFeedbackState(value: unknown): FeedbackState {
  return stateSchema.parse(value ?? EMPTY_STATE);
}

export function canClearFeedbackReceipt(record: LocalFeedbackReceipt, now = Date.now()): boolean {
  // Keep the deletion barrier until a stale tab can no longer submit the original request.
  return record.state === 'deleted' && Date.parse(record.createdAt) + FEEDBACK_RETRY_MS <= now;
}

/** Atomic state transitions also stop a late submit response from undoing deletion. */
export function changeFeedbackState(state: FeedbackState, change:
  | { kind: 'draft'; draft: FeedbackDraft }
  | { kind: 'prepare'; draft: FeedbackDraft & { prepared: PreparedFeedback } }
  | { kind: 'uncertain' | 'deleting' | 'deleted'; reportId: string }
  | { kind: 'clear-deleted'; now: number }
  | { kind: 'received'; receipt: FeedbackReceipt }): FeedbackState {
  const next = parseFeedbackState(structuredClone(state));
  if (change.kind === 'clear-deleted') {
    next.receipts = next.receipts.filter(record => !canClearFeedbackReceipt(record, change.now));
    return next;
  }
  if (change.kind === 'draft' || change.kind === 'prepare') {
    const draft = draftSchema.parse(change.draft);
    if (draft.prepared) {
      const existing = next.receipts.find(item => item.reportId === draft.prepared!.submission.reportId);
      if (existing && ['deleting', 'deleted', 'received'].includes(existing.state)) throw new Error('这份反馈已提交或正在删除，请新建反馈。');
      if (existing && existing.deleteToken !== draft.prepared.deleteToken) throw new Error('本机删除凭证不一致，未执行提交。');
      if (change.kind === 'prepare' && !existing) {
        next.receipts.push({ schemaVersion: 1, reportId: draft.prepared.submission.reportId, deleteToken: draft.prepared.deleteToken, createdAt: draft.prepared.submission.createdAt, state: 'prepared' });
      }
    }
    next.draft = draft;
    return next;
  }
  const id = change.kind === 'received' ? change.receipt.reportId : change.reportId;
  const record = next.receipts.find(item => item.reportId === id);
  if (!record) throw new Error('本机删除凭证不存在，未执行操作。');
  if (change.kind === 'received') {
    // A request may finish after another tab has requested deletion.
    if (record.state !== 'deleting' && record.state !== 'deleted') { record.state = 'received'; record.receipt = feedbackReceiptSchema.parse(change.receipt); }
  } else if (change.kind === 'uncertain') {
    if (record.state === 'prepared') record.state = 'uncertain';
  } else if (change.kind === 'deleting') {
    if (record.state !== 'deleted') record.state = 'deleting';
  } else record.state = 'deleted';
  if (change.kind !== 'uncertain' && next.draft?.prepared?.submission.reportId === id) next.draft = null;
  return next;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('zz-board-feedback', 1);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore('state');
    request.onerror = () => reject(new Error('反馈草稿暂时无法保存在本机。'));
    request.onblocked = () => { blocked = true; reject(new Error('反馈存储被其他窗口占用，请稍后重试。')); };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

async function transaction(update?: (state: FeedbackState) => FeedbackState): Promise<FeedbackState> {
  const database = await openDatabase();
  try {
    return await new Promise<FeedbackState>((resolve, reject) => {
      const tx = database.transaction('state', update ? 'readwrite' : 'readonly');
      let result: FeedbackState, failure: unknown;
      const request = tx.objectStore('state').get('feedback-v1');
      request.onsuccess = () => {
        try {
          result = parseFeedbackState(request.result);
          if (update) { result = update(result); tx.objectStore('state').put(result, 'feedback-v1'); }
        } catch (error) { failure = error; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure instanceof Error ? failure : new Error('反馈草稿未能保存，本次没有自动发送。'));
      tx.onerror = () => { /* The abort event is the durable failure boundary. */ };
    });
  } finally { database.close(); }
}

export const feedbackStore: FeedbackPersistence = {
  load: () => transaction(),
  saveDraft: async draft => { await transaction(state => changeFeedbackState(state, { kind: 'draft', draft })); },
  savePrepared: async draft => { await transaction(state => changeFeedbackState(state, { kind: 'prepare', draft })); },
  markUncertain: async reportId => { await transaction(state => changeFeedbackState(state, { kind: 'uncertain', reportId })); },
  markReceived: async receipt => {
    const state = await transaction(current => changeFeedbackState(current, { kind: 'received', receipt }));
    const status = state.receipts.find(record => record.reportId === receipt.reportId)?.state;
    if (status === 'received' || status === 'deleting' || status === 'deleted') return status;
    throw new Error('本机回执状态未能确认。');
  },
  markDeleting: async reportId => { await transaction(state => changeFeedbackState(state, { kind: 'deleting', reportId })); },
  markDeleted: async reportId => { await transaction(state => changeFeedbackState(state, { kind: 'deleted', reportId })); },
  clearDeletedReceipts: async () => { await transaction(state => changeFeedbackState(state, { kind: 'clear-deleted', now: Date.now() })); }
};
