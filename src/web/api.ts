import type { BoardState, CanvasNodeRecord, DrawingPreferences, HistoryStatus, InkStrokeRecord, ManualPriority, SkinComponents } from '../shared/schema.js';
import type { SkinComponentId, SkinManifest } from '../shared/skin.js';
import type { SelectionAction, SelectionResult } from '../shared/schema.js';
import type { ProjectRefreshResult, SavedProjectCheck } from '../shared/projectRefresh.js';
import type { SyncJob } from '../shared/summarySync.js';
import type { NoteContent } from '../shared/noteDocument.js';
import type { AutoCheckState, HistoryPreview, ProjectMilestone, TimelinePage } from '../shared/milestones.js';
import type { ConversationHistory, ConversationColumn, ConversationRefreshResult } from '../shared/conversationHistory.js';
import type { ExportSettings, SavedPng } from '../shared/imageExport.js';
import type { CodexAccess } from '../shared/codexAccess.js';
import type { SourceExcerptResult } from '../shared/sourceExcerpt.js';
import type { SummaryModel } from '../shared/summarySync.js';
import type { CanvasPageRecord } from '../shared/pages.js';
import type { ChangeWallpaper, Wallpaper, WallpaperPreset } from '../shared/wallpaper.js';

import type { ChangePriorityIcons, PriorityIcons } from '../shared/priorityIcons.js';
import { observeTrialHealth, recordTrialWeb } from './trialDiagnostics.js';

export interface HealthStatus {
  ok: true;
  appVersion: string;
  snapshotSchemaVersions: readonly number[];
  mode: string;
  uptimeSeconds: number;
  dataStoreId?: string;
  runtime?: string;
  trialDiagnostics?: 'active' | 'write_failed';
}

export interface SkinLibraryResponse {
  items: Array<{ key: string; skinId: string; version: string; displayName: string; description: string; builtIn: boolean; schemaVersion: SkinManifest['schemaVersion']; components: SkinComponentId[] }>;
  manifests: SkinManifest[];
}

const mutationHeaders = { 'content-type': 'application/json', 'x-zz-board-mutation': '1' };

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly current?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isConnectionError(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof DOMException && ['AbortError', 'TimeoutError'].includes(error.name));
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try { response = await fetch(url, init); }
  catch (error) {
    if (error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError') {
      recordTrialWeb('request_failure', 'failed');
    }
    throw error;
  }
  const payload = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiError(response.status, payload?.error || `${response.status} ${response.statusText}`, payload?.current);
  if (url === '/api/health') observeTrialHealth(payload?.trialDiagnostics);
  return payload as T;
}

export const api = {
  createPage: (name: string) => request<CanvasPageRecord>('/api/pages', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ name }) }),
  updatePage: (id: string, patch: { revision: number; name?: string; backgroundSkinRef?: string | null; wallpaper?: Wallpaper | null; autoCheckPaused?: boolean }) => request<CanvasPageRecord>(`/api/pages/${encodeURIComponent(id)}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(patch) }),
  setWallpaper: (change: ChangeWallpaper) => request<{ wallpaper: Wallpaper | null }>('/api/settings/wallpaper', {
    method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(change)
  }),
  wallpaperPreset: (id: string) => request<WallpaperPreset>(`/api/settings/wallpaper/presets/${encodeURIComponent(id)}`),
  saveWallpaperPreset: (preset: WallpaperPreset) => request<void>('/api/settings/wallpaper/presets', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(preset) }),
  deleteWallpaperPreset: (id: string) => request<void>(`/api/settings/wallpaper/presets/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { 'x-zz-board-mutation': '1' } }),
  archivePage: (id: string, input: { archived: boolean; revision: number; replacementDefaultPageId?: string }) => request<CanvasPageRecord>(`/api/pages/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) }),
  deletePage: (id: string, revision: number) => request<void>(`/api/pages/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders, body: JSON.stringify({ revision }) }),
  orderPages: (ids: string[]) => request('/api/pages/order', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ ids }) }),
  setActivePage: (pageId: string) => request('/api/pages/active', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ pageId }) }),
  setDefaultPage: (pageId: string) => request('/api/pages/default', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ pageId }) }),
  savePageViewport: (id: string, viewport: { x: number; y: number; zoom: number }) => request<CanvasPageRecord>(`/api/pages/${encodeURIComponent(id)}/viewport`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify(viewport) }),
  foldAll: (id: string, folded: boolean, revision: number) => request<{ nodes: CanvasNodeRecord[]; boardRevision: number }>(`/api/nodes/${encodeURIComponent(id)}/fold-all`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ folded, revision }) }),
  setPriorityIcons: (change: ChangePriorityIcons) => request<PriorityIcons>('/api/settings/priority-icons', {
    method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(change)
  }),
  codexAccess: () => request<CodexAccess>('/api/codex/access'),
  sourceExcerpt: (projectKey: string, threadKey: string, sourceId: string, signal: AbortSignal) =>
    request<SourceExcerptResult>(`/api/projects/${encodeURIComponent(projectKey)}/source-excerpt`, {
      method: 'POST', headers: mutationHeaders, body: JSON.stringify({ threadKey, sourceId }), cache: 'no-store', signal
    }),
  setCodexAccess: (value: Pick<CodexAccess, 'localRead' | 'modelUse'>) => request<CodexAccess>('/api/codex/access', { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(value) }),
  prepareCodex: () => request<{ available: boolean; reason: string; models: SummaryModel[] }>('/api/codex/prepare', { method: 'POST', headers: mutationHeaders, body: '{}' }),
  exportSettings: () => request<ExportSettings>('/api/settings/image-export'),
  setExportDirectory: (directory: string | null) => request<ExportSettings>('/api/settings/image-export', { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ directory }) }),
  savePng: (blob: Blob, kind: 'region' | 'note') => request<SavedPng>(`/api/image-exports?kind=${kind}`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-zz-board-mutation': '1' }, body: blob }),
  conversations: (key: string) => request<ConversationHistory>(`/api/projects/${encodeURIComponent(key)}/conversations`),
  refreshConversations: (key: string) => request<ConversationRefreshResult>(`/api/projects/${encodeURIComponent(key)}/conversations/refresh`, { method: 'POST', headers: mutationHeaders, body: '{}' }),
  earlierConversations: (key: string, threadKey: string, cursor: string | null) => request<ConversationRefreshResult>(`/api/projects/${encodeURIComponent(key)}/conversations/earlier`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ threadKey, cursor }) }),
  conversationTurns: (key: string, threadKey: string, options: { beforeTurnId?: string; limit?: number } = {}) => request<ConversationColumn>(`/api/projects/${encodeURIComponent(key)}/conversations/turns?${new URLSearchParams({ threadKey, ...(options.beforeTurnId ? { beforeTurnId: options.beforeTurnId } : {}), ...(options.limit ? { limit: String(options.limit) } : {}) })}`),
  readConversations: (key: string, items: Array<{ threadKey: string; turnId: string; revision: number }>) => request(`/api/projects/${encodeURIComponent(key)}/conversations/read`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ items }) }),
  autoCheck: () => request<AutoCheckState>('/api/sync/auto-check'),
  setAutoCheck: (enabled: boolean) => request<AutoCheckState>('/api/sync/auto-check', { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ enabled }) }),
  runAutoCheck: () => request<AutoCheckState>('/api/sync/auto-check/run', { method: 'POST', headers: mutationHeaders, body: '{}' }),
  timeline: (key: string, offset = 0) => request<TimelinePage>(`/api/projects/${encodeURIComponent(key)}/timeline?offset=${offset}`),
  readTimeline: (key: string, throughSequence: number, keys: string[]) => request(`/api/projects/${encodeURIComponent(key)}/timeline/read`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ throughSequence, keys }) }),
  timelineRevisions: (project: string, key: string) => request<{ items: ProjectMilestone[] }>(`/api/projects/${encodeURIComponent(project)}/timeline/${key}/revisions`),
  historyPreview: (key: string) => request<HistoryPreview>(`/api/projects/${encodeURIComponent(key)}/history/preview`),
  backfillHistory: (key: string, fingerprint: string) => request<SyncJob>(`/api/projects/${encodeURIComponent(key)}/history`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ fingerprint }) }),
  selection: (input: SelectionAction) => request<SelectionResult>('/api/selection', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) }),
  health: () => request<HealthStatus>('/api/health', { signal: AbortSignal.timeout(3_000) }),
  board: (priorityDate?: string) => request<BoardState>(priorityDate ? `/api/board?priorityDate=${encodeURIComponent(priorityDate)}` : '/api/board'),
  refreshProject: (key: string, options: { automatic?: boolean } = {}) => request<ProjectRefreshResult>(`/api/projects/${encodeURIComponent(key)}/refresh`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify(options) }),
  projectRefreshStatus: (key: string) => request<SavedProjectCheck>(`/api/projects/${encodeURIComponent(key)}/refresh-status`),
  syncJobs: () => request<{ jobs: SyncJob[] }>('/api/sync/jobs'),
  syncJobAction: (id: string, action: 'pause' | 'resume' | 'cancel') => request<SyncJob>(`/api/sync/jobs/${encodeURIComponent(id)}/${action}`, { method: 'POST', headers: mutationHeaders, body: '{}' }),
  daily: () => request<{ date: string; items: {
    todoKey: string;
    projectKey: string;
    manualPriority: ManualPriority;
    threadKey: string | null;
    sourceThreadKeys: string[];
    title: string;
    action: string;
    strength: string;
    minimumAction: string;
    why: string;
    unlocks: string;
    confidence: string;
  }[]; note: string }>('/api/daily-review'),
  createNote: (input: NoteContent & { pageId?: string; notePresentation?: 'note' | 'image'; clientRequestId?: string; title: string; x: number; y: number; width: number; height: number }) =>
    request<CanvasNodeRecord>('/api/notes', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) }),
  updateNode: (id: string, input: Record<string, unknown>) =>
    request<CanvasNodeRecord>(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(input) }),
  updateNodes: (updates: Array<{ id: string; patch: Record<string, unknown> & { revision: number } }>) =>
    request<{ nodes: CanvasNodeRecord[]; boardRevision: number }>('/api/nodes/batch', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ updates }) }),
  setNodePriorities: (updates: import('../shared/schema.js').NodePriorityUpdate[]) =>
    request<{ nodes: CanvasNodeRecord[]; boardRevision: number }>('/api/nodes/priorities', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ updates }) }),
  archiveNote: (id: string, archived: boolean, revision: number) =>
    request<CanvasNodeRecord>(`/api/notes/${encodeURIComponent(id)}/archive`, { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ archived, revision }) }),
  deleteNote: (id: string, revision: number) =>
    request<void>(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders, body: JSON.stringify({ revision }) }),
  annotate: (targetNodeId: string, body: string) =>
    request('/api/annotations', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ targetNodeId, body }) }),
  link: (sourceNodeId: string, targetNodeId: string, label = '') =>
    request('/api/links', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ sourceNodeId, targetNodeId, label }) }),
  updateLink: (id: string, input: { bend: { along: number; normal: number } | null; revision: number }) =>
    request(`/api/links/${encodeURIComponent(id)}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(input) }),
  deleteLink: (id: string, revision: number) =>
    request<void>(`/api/links/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders, body: JSON.stringify({ revision }) }),
  createInkStroke: (input: Omit<InkStrokeRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string }) =>
    request<InkStrokeRecord>('/api/ink-strokes', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) }),
  updateInkStroke: (id: string, patch: Partial<Omit<InkStrokeRecord, 'id' | 'createdAt' | 'updatedAt'>> & { revision: number }) =>
    request<InkStrokeRecord>(`/api/ink-strokes/${encodeURIComponent(id)}`, { method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(patch) }),
  deleteInkStroke: (id: string, revision: number) =>
    request<void>(`/api/ink-strokes/${encodeURIComponent(id)}`, { method: 'DELETE', headers: mutationHeaders, body: JSON.stringify({ revision }) }),
  applyInkBatch: (input: {
    creates: Array<Omit<InkStrokeRecord, 'id' | 'revision' | 'createdAt' | 'updatedAt'> & { id?: string }>;
    updates: Array<{ id: string; patch: Partial<Omit<InkStrokeRecord, 'id' | 'createdAt' | 'updatedAt'>> & { revision: number } }>;
    deletes: Array<{ id: string; revision: number }>;
  }) => request<{ created: InkStrokeRecord[]; updated: InkStrokeRecord[]; deletedIds: string[]; boardRevision: number }>(
    '/api/ink-strokes/batch', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(input) }),
  historyStatus: () => request<HistoryStatus>('/api/history/status'),
  undo: () => request<HistoryStatus>('/api/history/undo', { method: 'POST', headers: mutationHeaders, body: '{}' }),
  redo: () => request<HistoryStatus>('/api/history/redo', { method: 'POST', headers: mutationHeaders, body: '{}' }),
  skins: () => request<SkinLibraryResponse>('/api/skins'),
  installSkin: (text: string) => request<SkinLibraryResponse['items'][number]>('/api/skins/install', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text })
  }),
  saveViewport: (viewport: { x: number; y: number; zoom: number }) =>
    request('/api/settings/viewport', { method: 'POST', headers: mutationHeaders, body: JSON.stringify(viewport) }),
  setTheme: (theme: 'archive-paper' | 'ink-constellation') =>
    request('/api/settings/theme', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ theme }) }),
  setActiveSkin: (skinRef: string | null) =>
    request<{ skinRef: string | null }>('/api/settings/active-skin', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ skinRef }) }),
  setSkin: (input: { activeSkinRef?: string | null; components?: SkinComponents }) =>
    request<{ activeSkinRef: string | null; components: SkinComponents }>('/api/settings/skin', {
      method: 'POST', headers: mutationHeaders, body: JSON.stringify(input)
    }),
  setInteractionSettings: (input: { keyBindings?: Record<string, string>; drawingPreferences?: DrawingPreferences }) =>
    request<{ keyBindings: Record<string, string>; drawingPreferences: DrawingPreferences }>('/api/settings/interaction', {
      method: 'PATCH', headers: mutationHeaders, body: JSON.stringify(input)
    }),
  previewSnapshot: (text: string) => request<Record<string, unknown>>('/api/snapshots/preview', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text }) }),
  importSnapshot: (text: string) => request<Record<string, unknown>>('/api/snapshots/import', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ text }) }),
  syncLocal: () => request<Record<string, unknown>>('/api/sync/local', { method: 'POST', headers: mutationHeaders, body: '{}' }),
  pairCurator: (threadId: string) => request('/api/curator/pair', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ threadId }) }),
  askCurator: (question: string) => request<Record<string, unknown>>('/api/curator/ask', { method: 'POST', headers: mutationHeaders, body: JSON.stringify({ question }) })
};
