import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import {
  Background, BackgroundVariant, MiniMap, ReactFlow,
  applyNodeChanges, useReactFlow, type Edge, type Node, type NodeChange, type NodeMouseHandler, type OnNodeDrag, type Viewport
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { BoardState, BoardThread, CanvasNodeRecord, DrawingPreferences, InkStrokeRecord } from '../shared/schema.js';
import { APP_VERSION } from '../shared/version.js';
import { api, isConnectionError, type HealthStatus } from './api.js';
import { visibleWallpaper } from '../shared/wallpaper.js';
import { WallpaperScene, WallpaperSettings } from './WallpaperSettings.js';
import { useBoardNotice } from './boardNotice.js';
import { ProjectNotes, NoteChecklist } from './ProjectNotes.js';
import {
  flushQueuedNotes,
  listQueuedNotes,
  overlayQueuedNotes,
  patchQueuedNode,
  readBoardCache,
  readNoteEdits, writeNoteEdits,
  saveBoardCache,
  updateQueuedNote,
  type EditableNoteDraft
} from './offlineStore.js';
import { noteDisplayText, taskDisplayTitle } from './bubblePresentation.js';
import { TaskBubble, type BubbleData } from './TaskBubble.js';
import { matchesCanvasView, type CanvasLens } from './canvasVisibility.js';
import { canvasNodeGeometry } from './canvasNodeGeometry.js';
import { NoteMetadata } from './NoteMetadata.js';
import { FoldedNoteSection } from './FoldedNoteSection.js';
import { NoteRecoveryList } from './NoteRecoveryList.js';
import { SelectionOverlay } from './SelectionOverlay.js';
import { selectionBounds } from './inkGeometry.js';
import { scaledNodePreview, scaledInk, selectionScaleLimits, type SelectionScale } from '../shared/selectionScale.js';
import { BubbleHoverPreview } from './BubbleHoverPreview.js';
import { ArchivePanel } from './ArchivePanel.js';
import { archivedNoteRelations, archivedRelationsForNode, type ArchivedNoteRelation } from './archiveRelations.js';
import { FloatingLinkEdge } from './FloatingLinkEdge.js';
import { ProjectDetail, ThreadSummary } from './ProjectDetail.js';
import { ProjectTimeline } from './ProjectTimeline.js';
import { ConversationHistory } from './ConversationHistory.js';
import { ProjectRefreshStatus } from './ProjectRefreshStatus.js';
import { SourceThreadTitles } from './ThreadSourceLink.js';
import { projectReading, readingDate, readingQualifier } from './projectContextReading.js';
import { archivedNotes, shouldArchiveNote } from './noteArchive.js';
import {
  canvasLinks, contextForNode, hasLinkBetween, linkTouchesSelection, persistedLinkEndpoint, projectNodeForThread,
  visibleCanvasRecords, type ProjectBubbleContext
} from './projectCanvas.js';
import { actionLabel } from './labels.js';
import { dragRect, intersectsRect, isBroadScale, selectionAfterClick, selectionAfterMarquee, type ScreenRect } from './canvasInteraction.js';
import { priorityOnDate, type NoteSchedule } from '../shared/notePriority.js';
import { usePriorityDate } from './usePriorityDate.js';
import { displayedPriority, manualPriorityLabel, projectPriorityMap, portfolioActions } from './manualPriority.js';
import { InkCanvas, type InkCanvasTool, type InkEraseAction, type InkLassoMode, type InkPreset, type InkTransformUpdate, type NewInkStroke } from './InkCanvas.js';
import { ToolPalette } from './ToolPalette.js';
import { ControlSettings, DataSettings, defaultDrawingPreferences, type SettingsDraft } from './SettingsPanel.js';
import { FeedbackPanel } from './FeedbackPanel.js';
import { OnboardingPanel } from './OnboardingPanel.js';
import { codexAccessSchema, type CodexAccess } from '../shared/codexAccess.js';
import { defaultShortcuts, mergeShortcuts, panelOwnsCanvasKeys, shortcutMatches, startsCanvasPan, type ShortcutMap } from './shortcuts.js';
import { SkinPanel, type SkinLibraryItem } from './SkinPanel.js';
import { BUILT_IN_SKINS, DEFAULT_LIGHT_SKIN_KEY, DEFAULT_SKIN_KEY, createSkinReference, getSkinComponent, skinComponentIds, skinVersionKey, type SkinComponentId, type SkinManifest } from '../shared/skin.js';
import { applySkinVariables, composedSkinStyle, manifestForReference, nodeManifestSkinStyle, skinAspectLockedDefault, skinComponentManifest, skinCornerRadii, skinShape } from './skinRuntime.js';
import { BoardMenu, menuDetails, menuSections, type MenuDetail, type MenuLocation, type MenuSection } from './BoardMenu.js';
import { MenuHeader, MenuPage, type MenuNavigation } from './MenuHeader.js';
import { SummarySyncPanel } from './SummarySyncPanel.js';
import { actionRecordTime, awaitsResponse, historicalAction } from './projectActions.js';
import { NoteAutosave, noteRequestNodeId } from './noteAutosave.js';
import { getNoteFoldEligibility, visibleFoldHost } from '../shared/noteFolding.js';
import { foldedCanvasProjection } from './foldedCanvas.js';
import { floatingLinkGeometry } from './linkGeometry.js';
import { foldMotionFrames } from './foldMotion.js';
import { FocusedNote } from './FocusedNote.js';
import { NoteScheduleForm } from './NoteScheduleForm.js';
import { PriorityIconSettings } from './PriorityIcon.js';
import { defaultPriorityIcons } from '../shared/priorityIcons.js';
import { noteClipboardData, pastedNoteCard, type NoteCardContent } from './noteTransfer.js';
import { copyCurrentNoteText, copyNoteImage } from './noteClipboard.js';
import { NoteOriginLink } from './NoteOriginLink.js';
import { ImageViewer } from './NoteDocumentView.js';
import { clipboardImages, uploadImage, type ClipboardImage } from './mediaClient.js';
import { ImageExportFeedback } from './ImageExportFeedback.js';
import type { NoteDocument } from '../shared/noteDocument.js';
import { ExportRegion } from './ExportRegion.js';
import { installTouchViewport } from './touchViewport.js';
import { createViewportSaver } from './viewportSaver.js';
import { boardPages, DEFAULT_PAGE_ID, pageId, type CanvasPageRecord } from '../shared/pages.js';
import { PageNavigation } from './PageNavigation.js';
import { pageMovePreview } from './pageCanvas.js';
import { finishCanvasEditors } from './editorNavigation.js';

type Lens = CanvasLens;
type ConnectionState = 'checking' | 'online' | 'offline' | 'incompatible';
const nodeTypes = { bubble: memo(TaskBubble) };
const edgeTypes = { floating: FloatingLinkEdge };

export default function App() {
  const priorityDate = usePriorityDate();
  const [board, setBoard] = useState<BoardState | null>(null);
  const [currentPageId, setCurrentPageId] = useState(DEFAULT_PAGE_ID);
  const currentPageRef = useRef(DEFAULT_PAGE_ID);
  const pageInitialized = useRef(false);
  const pageTransition = useRef(false);
  const [navigationOnly, setNavigationOnly] = useState(false);
  const [moveTarget, setMoveTarget] = useState('');
  const pages = board ? boardPages(board) : [];
  const currentPage = pages.find(page => page.id === currentPageId);
  const readOnly = Boolean(currentPage?.archivedAt);
  const readOnlyRef = useRef(false);
  readOnlyRef.current = readOnly;
  const [nodes, setNodes] = useState<Node<BubbleData>[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selectedEdgeRef = useRef<string | null>(null);
  const [editTick, setEditTick] = useState(0);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [noteFocusAnchor, setNoteFocusAnchor] = useState<HTMLElement | null>(null);
  const [notePanel, setNotePanel] = useState<'details' | 'schedule' | null>(null);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [foldAnimation, setFoldAnimation] = useState<{ id: string; hostId: string; opening: boolean } | null>(null);
  const foldBusy = useRef(false);
  const [broadScale, setBroadScale] = useState(false);
  const [hoverPreview, setHoverPreview] = useState<{ nodeId: string; x: number; y: number } | null>(null);
  const [hoveredLinkNodeId, setHoveredLinkNodeId] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<ScreenRect | null>(null);
  const [projectKey, setProjectKey] = useState<string>('all');
  const [lens, setLens] = useState<Lens>('all');
  const [menu, setMenu] = useState<MenuLocation | null>(null);
  const drawerOpen = menu !== null;
  const detail = menu?.path.at(-1);
  const menuHandle = useRef<HTMLButtonElement>(null);
  const projectMenuTrigger = useRef<HTMLElement | null>(null);
  const menuLeaveGuard = useRef<(() => boolean) | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({});
  function canLeaveMenu() { return menuLeaveGuard.current?.() ?? true; }
  function openSection(section: MenuSection = 'projects') {
    if (!canLeaveMenu()) return;
    clearHoverPreview();
    setMenu({ section, path: [] });
  }
  function openMenuDetail(next: MenuDetail, entrySection: MenuSection) {
    if (!canLeaveMenu()) return;
    clearHoverPreview();
    setMenu(current => {
      const location = current ?? { section: entrySection, path: [] };
      const index = location.path.indexOf(next);
      return { ...location, path: index < 0 ? [...location.path, next] : location.path.slice(0, index + 1) };
    });
  }
  function closeBoardMenu() {
    if (!canLeaveMenu()) return;
    setMenu(null);
    requestAnimationFrame(() => {
      const trigger = projectMenuTrigger.current;
      const target = menu?.fromProject && (trigger?.isConnected ? trigger : document.querySelector<HTMLElement>('.project-detail-panel .project-refresh button'));
      (target || menuHandle.current)?.focus({ preventScroll: true });
    });
  }
  function backInMenu() {
    if (menu?.fromProject && menu.path.length === 1) closeBoardMenu();
    else if (canLeaveMenu()) setMenu(current => current && { ...current, path: current.path.slice(0, -1) });
  }
  function toggleBoardMenu() {
    if (drawerOpen) closeBoardMenu();
    else openSection('projects');
  }
  useEffect(() => { if (!drawerOpen) setSettingsDraft({}); }, [drawerOpen]);
  const [archiveFocusId, setArchiveFocusId] = useState<string | null>(null);
  const [threadToLocate, setThreadToLocate] = useState<{ key: string } | null>(null);
  const [snapshotText, setSnapshotText] = useState('');
  const [snapshotPreview, setSnapshotPreview] = useState<Record<string, unknown> | null>(null);
  const {notice, setNotice, flashNotice, noticeKey, transient} = useBoardNotice();
  const [curatorQuestion, setCuratorQuestion] = useState('我今天应该先介入哪三件事？');
  const [curatorAnswer, setCuratorAnswer] = useState('');
  const [connection, setConnection] = useState<ConnectionState>('checking');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [startupError, setStartupError] = useState('');
  const [versionMismatch, setVersionMismatch] = useState<string | null>(null);
  const [serviceHealth, setServiceHealth] = useState<(HealthStatus & { checkedAt: string }) | null>(null);
  const [inkTool, setInkTool] = useState<InkCanvasTool>('select');
  const [selectedInkIds, setSelectedInkIds] = useState<string[]>([]);
  const [spacePan, setSpacePan] = useState(false);
  const [touchNavigating, setTouchNavigating] = useState(false);
  const [viewportNavigating, setViewportNavigating] = useState(false);
  const [canvasViewport, setCanvasViewport] = useState<Viewport>({ x: 0, y: 0, zoom: .78 });
  const [drawingPreferences, setDrawingPreferences] = useState<DrawingPreferences>(defaultDrawingPreferences);
  const [codexAccess, setCodexAccess] = useState<CodexAccess | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const lastCanvasPointer = useRef<{ x: number; y: number } | null>(null);
  const pasteBusy = useRef(false);
  const [failedPaste, setFailedPaste] = useState<{ file: ClipboardImage; pageId: string; x: number; y: number; requestId: string }[]>([]);
  const [altPressed, setAltPressed] = useState(false);
  const [skinItems, setSkinItems] = useState<SkinLibraryItem[]>(() => BUILT_IN_SKINS.map(({ manifest }) => ({
    key: skinVersionKey(manifest), skinId: manifest.skinId, version: manifest.version,
    displayName: manifest.displayName, description: manifest.description, builtIn: true,
    schemaVersion: manifest.schemaVersion,
    components: skinComponentIds(manifest)
  })));
  const [skinManifests, setSkinManifests] = useState<SkinManifest[]>(() => BUILT_IN_SKINS.map((item) => item.manifest));
  const viewportSaver = useRef<ReturnType<typeof createViewportSaver> | null>(null);
  const nodesRef = useRef<Node<BubbleData>[]>([]);
  const boardRevisionRef = useRef(0);
  const mutationEpoch = useRef(0);
  const reloadSequence = useRef(0);
  const appliedReloadSequence = useRef(0);
  const drawingWriteQueue = useRef(Promise.resolve());
  const drawingWritesPending = useRef(0);
  const boardRef = useRef<BoardState | null>(null);
  const connectionRef = useRef<ConnectionState>('checking');
  const recoveryRef = useRef(false);
  useEffect(() => {
    const id = currentPageId;
    const saver = createViewportSaver({ online: () => connectionRef.current === 'online' && !readOnlyRef.current, save: view => api.savePageViewport(id, view), failed: handleMutationError });
    viewportSaver.current = saver;
    return () => { saver.dispose(); viewportSaver.current = null; };
  }, [currentPageId]);
  const linkBusyRef = useRef(false);
  const selectedIdRef = useRef<string | null>(null);
  const selectedIdsRef = useRef<string[]>([]);
  const broadScaleRef = useRef(false);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverNodeRef = useRef<string | null>(null);
  const stageRef = useRef<HTMLElement>(null);
  const marqueeRef = useRef<{ pointerId: number; startX: number; startY: number; currentX: number; currentY: number; additive: boolean } | null>(null);
  const { fitView, screenToFlowPosition, setViewport, getViewport, zoomIn, zoomOut } = useReactFlow();
  const touchViewportRef = useRef<ReturnType<typeof installTouchViewport> | null>(null);
  const [noteSaver] = useState(() => new NoteAutosave({
    create: api.createNote, update: api.updateNode, persist: writeNoteEdits,
    online: () => connectionRef.current === 'online',
    changed: () => setEditTick((tick) => tick + 1),
    storageError: () => setNotice('本机恢复草稿写入失败，请先复制文字；不要关闭窗口。'),
    failed: setNotice,
    accepted: (record) => {
      mutationEpoch.current++;
      const current = boardRef.current;
      if (!current) return;
      const next = { ...current, nodes: current.nodes.some((n) => n.id === record.id)
        ? current.nodes.map((n) => n.id === record.id && n.revision <= record.revision ? record : n)
        : [...current.nodes, record] };
      boardRef.current = next; setBoard(next);
      void saveBoardCache(next).then(setCachedAt).catch(() => undefined);
      window.setTimeout(() => { void reload().catch(handleMutationError); }, 150);
      setNodes((items) => {
        const nextNodes = items.map((n) => n.id === record.id ? { ...n, data: { ...n.data, record } } : n);
        nodesRef.current = nextNodes; return nextNodes;
      });
    }
  }));
  const [noteRecoveryOpen, setNoteRecoveryOpen] = useState(false);
  const historyBusyRef = useRef(false);
  const selectionMoveRef = useRef<{ nodes: CanvasNodeRecord[]; ink: InkStrokeRecord[] } | null>(null);
  const [selectionDelta, setSelectionDelta] = useState<{ x: number; y: number } | null>(null);
  const [selectionScale, setSelectionScale] = useState<SelectionScale | null>(null);
  const [selectionAsGroup, setSelectionAsGroup] = useState(false);
  const selectionBusyRef = useRef(false);
  const [canvasBusy, setCanvasBusy] = useState(false);
  const nodeDragModeRef = useRef<'online' | 'offline' | 'blocked' | null>(null);
  const shortcuts = useMemo(() => mergeShortcuts(board?.settings.keyBindings || defaultShortcuts), [board?.settings.keyBindings]);
  const touchCallbacks = useRef({
    onStart: () => {}, onChange: (_view: Viewport) => {}, onEnd: (_view: Viewport) => {},
  });
  touchCallbacks.current = {
    onStart: () => {
      clearHoverPreview();
      if (selectionMoveRef.current || nodeDragModeRef.current) cancelSelectionMove();
      nodeDragModeRef.current = null;
      viewportSaver.current?.cancel();
    },
    onChange: view => { void setViewport(view, { duration: 0 }); trackScale(view); setCanvasViewport(view); },
    onEnd: view => queueViewportSave(view),
  };
  const boardReady = !!board;
  useEffect(() => {
    if (!boardReady || !stageRef.current) return;
    const controller = installTouchViewport(stageRef.current, {
      getViewport,
      onStart: () => touchCallbacks.current.onStart(),
      onChange: view => touchCallbacks.current.onChange(view),
      onEnd: view => touchCallbacks.current.onEnd(view),
      onActive: setTouchNavigating,
    });
    touchViewportRef.current = controller;
    return () => { controller.dispose(); touchViewportRef.current = null; };
  }, [boardReady, getViewport]);

  function changeConnection(next: ConnectionState) {
    connectionRef.current = next;
    if (next !== 'online') viewportSaver.current?.cancel();
    setConnection(next);
  }

  function writable(): boolean {
    if (!readOnlyRef.current) return true;
    setNotice('这是归档页面；恢复页面后才能修改内容。');
    return false;
  }

  async function finishPageEditing(): Promise<boolean> {
    if (!await finishCanvasEditors()) return false;
    try {
      await noteSaver.durable();
      const entries = [...noteSaver.entries.values()].filter(entry => pageId(entry.record) === currentPageRef.current && noteSaver.dirty(entry.record.id));
      if (entries.some(entry => noteSaver.isComposing(entry.record.id) || entry.status === 'conflict')) {
        setNoteRecoveryOpen(true); setNotice('请先完成组字或处理便签冲突，再切换页面。'); return false;
      }
      if (connectionRef.current === 'online') {
        for (const entry of entries) if (!await noteSaver.finishEditing(entry.record.id)) { setNoteRecoveryOpen(true); return false; }
      }
      await noteSaver.durable();
      setEditingNoteId(null);
      return true;
    } catch { setNotice('本机恢复草稿尚未保存，已保留当前页面，请先复制需要的文字。'); return false; }
  }

  async function switchPage(id: string): Promise<boolean> {
    if (pageTransition.current || selectionBusyRef.current || selectionMoveRef.current) return false;
    const target = boardRef.current && boardPages(boardRef.current).find(page => page.id === id);
    if (!target) { setNotice('页面已不存在，原内容和恢复草稿保留。'); return false; }
    if (id === currentPageRef.current) return true;
    pageTransition.current = true;
    try {
      if (!await finishPageEditing()) return false;
      const leavingId = currentPageRef.current;
      const view = getViewport();
      viewportSaver.current?.cancel();
      const current = boardRef.current!;
      const next = { ...current, pages: boardPages(current).map(page => page.id === leavingId && !page.archivedAt ? { ...page, viewport: view } : page),
        settings: { ...current.settings, ...(!target.archivedAt ? { activePageId: id } : {}) } };
      await saveBoardCache(next).then(setCachedAt);
      if (connectionRef.current === 'online' && !boardPages(current).find(page => page.id === leavingId)?.archivedAt) await api.savePageViewport(leavingId, view);
      if (connectionRef.current === 'online' && !target.archivedAt) await api.setActivePage(id);
      currentPageRef.current = id; setCurrentPageId(id);
      boardRef.current = next; setBoard(next);
      applySelection([]); setSelectedInkIds([]); setSelectedEdgeId(null); selectedEdgeRef.current = null;
      setNavigationOnly(true); setProjectKey('all'); setLens('all'); setThreadToLocate(null);
      setExportOpen(false); setInkTool('select');
      clearHoverPreview(); setMarquee(null); marqueeRef.current = null; setHoverPreview(null); setFoldAnimation(null);
      await setViewport(target.viewport, { duration: 0 }); setCanvasViewport(target.viewport); trackScale(target.viewport);
      return true;
    } catch (error) { handleMutationError(error); return false; }
    finally { pageTransition.current = false; }
  }

  async function locateRecord(record: CanvasNodeRecord, threadKey?: string, fromMenu = false) {
    const openProject = fromMenu && record.kind === 'task' && Boolean(record.projectKey);
    if ((threadKey || fromMenu) && pageId(record) === currentPageRef.current && !await finishPageEditing()) return;
    if (!await switchPage(pageId(record))) return;
    const current = boardRef.current!;
    const records = visibleCanvasRecords(current).filter(item => pageId(item) === currentPageRef.current);
    if (threadKey && projectNodeForThread(current, threadKey, records)?.id !== record.id) {
      setNotice('这条对话的项目位置已变化，请重新选择来源。');
      return;
    }
    const hostId = visibleFoldHost(record.id, records, canvasLinks(current, records));
    setProjectKey('all'); setLens('all'); setMenu(null);
    setNavigationOnly(!threadKey && !openProject); setThreadToLocate(threadKey ? { key: threadKey } : null);
    applySelection([threadKey ? record.id : hostId]);
    requestAnimationFrame(() => void fitView({ nodes: [{ id: hostId }], padding: .8, duration: 250, maxZoom: 1 }));
    if (fromMenu) requestAnimationFrame(() => {
      const source = threadKey && document.querySelector<HTMLElement>(`.thread-summary[data-thread-key="${CSS.escape(threadKey)}"]`);
      if (source) source.scrollIntoView({ block: 'nearest' });
      const target = (openProject || threadKey) ? source || document.querySelector<HTMLElement>('.detail-panel[aria-label] .panel-close')
        : stageRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(hostId)}"]`);
      target?.focus({ preventScroll: true });
    });
    if (hostId !== record.id) flashNotice('已定位到收纳宿主；可展开全部找回该便签。');
  }

  async function mutatePage(work: () => Promise<unknown>) {
    if (!await finishPageEditing()) return false;
    try { await work(); mutationEpoch.current++; await reload(); return true; }
    catch (error) { handleMutationError(error); return false; }
  }

  async function createPage(name: string) {
    let created: CanvasPageRecord | undefined;
    if (await mutatePage(async () => { created = await api.createPage(name); }) && created) return switchPage(created.id);
    return false;
  }

  async function patchPage(page: CanvasPageRecord, patch: { name?: string; backgroundSkinRef?: string | null; autoCheckPaused?: boolean }) {
    await mutatePage(() => api.updatePage(page.id, { ...patch, revision: page.revision }));
  }

  async function deleteEmptyPage(page: CanvasPageRecord) {
    const queued = await listQueuedNotes();
    if (queued.some(item => pageId(item.input) === page.id) || failedPaste.some(item => item.pageId === page.id)) return setNotice('本页仍有待同步的便签或图片，请先处理再删除。');
    await mutatePage(() => api.deletePage(page.id, page.revision));
  }

  async function changePageArchive(page: CanvasPageRecord, archived: boolean) {
    let replacementDefaultPageId: string | undefined;
    if (archived && page.id === boardRef.current?.settings.defaultPageId) {
      const choices = boardPages(boardRef.current!).filter(item => !item.archivedAt && item.id !== page.id);
      if (!choices.length) return setNotice('请先创建另一个活动页面。');
      const name = window.prompt(`归档接收页前，请输入新的接收页名称：${choices.map(item => item.name).join('、')}`, choices[0]!.name);
      if (name === null) return;
      const chosen = choices.find(item => item.name === name);
      if (!chosen) return setNotice('没有找到这个活动页，请重新选择。');
      replacementDefaultPageId = chosen.id;
    }
    if (failedPaste.some(item => item.pageId === page.id)) return setNotice('本页仍有图片待重试，请先处理再归档。');
    if (await mutatePage(async () => {
      const fresh = boardPages(await api.board()).find(item => item.id === page.id);
      if (!fresh) throw new Error('页面已不存在。');
      await api.archivePage(page.id, { archived, revision: fresh.revision, replacementDefaultPageId });
    })) flashNotice(archived ? '页面已归档，自动检查暂停；已发出的当前请求可以收尾。' : '页面已恢复，自动检查保持暂停，可手动继续。');
  }

  async function foldAll(id: string, folded: boolean) {
    if (!writable() || !await finishPageEditing()) return;
    const record = boardRef.current?.nodes.find(node => node.id === id);
    if (!record) return;
    try { await api.foldAll(id, folded, record.revision); mutationEpoch.current++; await reload(); flashNotice(folded ? '已折叠可收纳的下游内容，可一次撤销。' : '已展开全部，原位置保持。'); }
    catch (error) { handleMutationError(error); }
  }

  async function moveSelectionToPage(targetId: string) {
    if (!targetId || !writable() || connectionRef.current !== 'online' || !await finishPageEditing()) return;
    const current = boardRef.current!;
    const preview = pageMovePreview(current, selectedIdsRef.current, selectedInkIds);
    if (!preview.nodes.length && !preview.ink.length) return;
    if (preview.nodes.some(node => node.id.startsWith('offline-note:') || !current.nodes.some(item => item.id === node.id))) return setNotice('请先同步选区中的草稿。');
    const target = boardPages(current).find(page => page.id === targetId && !page.archivedAt);
    if (!target) return;
    const center = { x: (-target.viewport.x + stageWidth / 2) / target.viewport.zoom, y: (-target.viewport.y + stageHeight / 2) / target.viewport.zoom };
    const inkBounds = selectionBounds(preview.ink);
    const rects = [...preview.nodes, ...(inkBounds ? [inkBounds] : [])];
    const left = Math.min(...rects.map(item => item.x)), top = Math.min(...rects.map(item => item.y));
    const right = Math.max(...rects.map(item => item.x + item.width)), bottom = Math.max(...rects.map(item => item.y + item.height));
    const message = `移动到「${target.name}」：${preview.nodes.length} 个气泡/便签、${preview.ink.length} 条笔迹；${preview.externalLinks} 个关联留在其他页面。${!target.autoCheckPaused ? '目标页允许自动检查；全局开启时后续可能产生用量。' : '目标页自动检查暂停。'}`;
    if (!window.confirm(message)) return;
    selectionBusyRef.current = true; setCanvasBusy(true);
    try {
      await api.selection({ action: 'movePage', targetPageId: targetId, nodes: preview.nodes.map(node => ({ id: node.id, revision: node.revision })), ink: preview.ink.map(stroke => ({ id: stroke.id, revision: stroke.revision })), delta: { x: center.x - (left + right) / 2, y: center.y - (top + bottom) / 2 } });
      mutationEpoch.current++; applySelection([]); setSelectedInkIds([]); await reload();
      selectionBusyRef.current = false; await switchPage(targetId); flashNotice(message); setMoveTarget('');
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { selectionBusyRef.current = false; setCanvasBusy(false); }
  }

  function applySelection(ids: readonly string[], primary: string | null = null) {
    setNoteFocusAnchor(null);
    setNotePanel(null);
    setMoveTarget('');
    setSelectionAsGroup(false);
    const next = [...new Set(ids)];
    const nextPrimary = primary && next.includes(primary) ? primary : next.at(-1) || null;
    const old = selectedIdRef.current;
    if (old && old !== nextPrimary && old !== editingNoteId) finishNote(old);
    selectedEdgeRef.current = null; setSelectedEdgeId(null);
    selectedIdsRef.current = next;
    selectedIdRef.current = nextPrimary;
    setSelectedIds(next);
    setSelectedId(nextPrimary);
  }

  const reload = useCallback(async (markOnline = true) => {
    const epoch = mutationEpoch.current;
    const sequence = ++reloadSequence.current;
    const previousTaskCount = boardRef.current?.projects.length;
    const next = await api.board();
    const queued = await listQueuedNotes().catch(() => []);
    if (epoch !== mutationEpoch.current || sequence < appliedReloadSequence.current || boardRevision(next) < boardRevisionRef.current) return;
    appliedReloadSequence.current = sequence;
    const merged = overlayQueuedNotes(next, queued);
    const availablePages = boardPages(merged);
    if (!pageInitialized.current || !availablePages.some(page => page.id === currentPageRef.current)) {
      const id = availablePages.find(page => page.id === merged.settings.activePageId && !page.archivedAt)?.id || availablePages.find(page => !page.archivedAt)?.id || DEFAULT_PAGE_ID;
      const page = availablePages.find(page => page.id === id);
      if (pageInitialized.current && page) { void setViewport(page.viewport, { duration: 0 }); setCanvasViewport(page.viewport); }
      currentPageRef.current = id; setCurrentPageId(id); pageInitialized.current = true;
    }
    boardRevisionRef.current = boardRevision(merged);
    boardRef.current = merged;
    noteSaver.reconcile(merged.nodes);
    setBoard(merged);
    if (!drawingWritesPending.current) setDrawingPreferences({ ...defaultDrawingPreferences, ...merged.settings.drawingPreferences });
    const drafts = nodesRef.current.filter((node) => !merged.nodes.some((n) => n.id === node.id) && noteSaver.dirty(node.id));
    const available = new Set([...visibleCanvasRecords(merged).map((record) => record.id), ...drafts.map((node) => node.id)]);
    const retainedSelection = selectedIdsRef.current.filter((id) => available.has(id));
    if (retainedSelection.length !== selectedIdsRef.current.length) applySelection(retainedSelection, retainedSelection.includes(selectedIdRef.current || '') ? selectedIdRef.current : retainedSelection.at(-1) || null);
    setNodes([...toFlowNodes(merged, retainedSelection, persistResize, false), ...drafts]);
    if (previousTaskCount === 0 && merged.projects.length > 0 && boardPages(merged).find(page => page.id === currentPageRef.current)?.id === merged.settings.defaultPageId) {
      window.setTimeout(() => void fitView({ padding: 0.24, duration: 480, maxZoom: 1 }), 80);
    }
    setQueuedCount(queued.length);
    if (markOnline) changeConnection('online');
    setStartupError('');
    void saveBoardCache(merged).then(setCachedAt).catch(() => undefined);
  // Selection is deliberately reapplied on explicit reloads.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitView]);

  useEffect(() => {
    let disposed = false;
    void bootstrap();
    const healthTimer = window.setInterval(() => { if (!disposed) void recoverConnection(); }, 15_000);
    const online = () => void recoverConnection();
    const serviceRecovering = () => {
      changeConnection('offline');
      setNotice('本地服务正在恢复；画布保持打开，便签草稿保留在本机。');
    };
    window.addEventListener('online', online);
    window.addEventListener('zz-board-service-recovering', serviceRecovering);
    return () => {
      disposed = true;
      window.clearInterval(healthTimer);
      window.removeEventListener('online', online);
      window.removeEventListener('zz-board-service-recovering', serviceRecovering);
      if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  useEffect(() => {
    if (!board) return;
    Object.assign(window, { __ZZ_BOARD_READY__: true });
    return () => { Object.assign(window, { __ZZ_BOARD_READY__: false }); };
  }, [Boolean(board)]);

  useEffect(() => { nodesRef.current = nodes; }, [nodes]);

  useEffect(() => {
    let reloadTimer: number | null = null;
    const events = new EventSource('/events');
    events.addEventListener('codex-access', (event: MessageEvent<string>) => {
      try { setCodexAccess(codexAccessSchema.parse(JSON.parse(event.data))); }
      catch { setCodexAccess(null); }
    });
    events.onerror = () => setCodexAccess(null);
    events.onmessage = (event) => {
      if (connectionRef.current !== 'online') return;
      try {
        const revision = Number((JSON.parse(event.data) as { boardRevision?: unknown }).boardRevision);
        if (!Number.isFinite(revision) || revision <= boardRevisionRef.current) return;
        boardRevisionRef.current = revision;
      } catch {
        return;
      }
      if (reloadTimer) window.clearTimeout(reloadTimer);
      reloadTimer = window.setTimeout(() => { void reload().catch(handleMutationError); }, 120);
    };
    return () => {
      if (reloadTimer) window.clearTimeout(reloadTimer);
      events.close();
    };
  }, [reload]);

  async function bootstrap() {
    noteSaver.restore(await readNoteEdits().catch(() => []));
    try {
      await recoverConnection(true);
      await refreshSkins();
      void noteSaver.flushAll();
    } catch (error) {
      const cached = await readBoardCache().catch(() => null);
      const queued = await listQueuedNotes().catch(() => []);
      if (cached) {
        const merged = overlayQueuedNotes(cached.board, queued);
        const id = boardPages(merged).find(page => page.id === merged.settings.activePageId && !page.archivedAt)?.id || boardPages(merged).find(page => !page.archivedAt)?.id || DEFAULT_PAGE_ID;
        currentPageRef.current = id; setCurrentPageId(id); pageInitialized.current = true;
        boardRef.current = merged;
        setBoard(merged);
        setDrawingPreferences({ ...defaultDrawingPreferences, ...merged.settings.drawingPreferences });
        setNodes(toFlowNodes(merged, [], persistResize, true));
        setCachedAt(cached.savedAt);
        setQueuedCount(queued.length);
        changeConnection('offline');
        setNotice('本地服务暂时没有响应；已打开最后一次看板，便签会先安全排队。');
      } else {
        changeConnection('offline');
        setStartupError(errorMessage(error));
      }
    }
  }

  async function recoverConnection(initial = false) {
    if (recoveryRef.current) return;
    recoveryRef.current = true;
    const wasOffline = connectionRef.current === 'offline';
    try {
      const health = await api.health();
      setServiceHealth({ ...health, checkedAt: new Date().toISOString() });
      const remoteVersion = health.appVersion || '未知';
      if (remoteVersion !== APP_VERSION) {
        setVersionMismatch(remoteVersion);
        if (!boardRef.current) await reload(false);
        changeConnection('incompatible');
        if (boardRef.current) setNodes(toFlowNodes(boardRef.current, selectedIdsRef.current, persistResize, true));
        setNotice('本地服务与页面版本不同；已暂停写入，请刷新页面完成更新。');
        return;
      }
      setVersionMismatch(null);
      const flushed = await flushQueuedNotes(api.createNote);
      await reload();
      void noteSaver.flushAll();
      if (flushed.remaining > 0) setNotice(`本地服务已连接，但仍有 ${flushed.remaining} 张便签待同步${flushed.blockedBy ? `：${flushed.blockedBy}` : '。'}`);
      else if (flushed.discarded > 0) flashNotice(`已取消 ${flushed.discarded} 张已被永久删除便签的离线重试${flushed.sent ? `，另同步 ${flushed.sent} 张便签` : ''}。`);
      else if (flushed.sent > 0) flashNotice(`连接恢复，已把 ${flushed.sent} 张离线便签放回看板。`);
      else if (!initial && wasOffline) flashNotice('本地服务已恢复连接。');
    } catch (error) {
      changeConnection('offline');
      if (initial) throw error;
    } finally {
      recoveryRef.current = false;
    }
  }

  const skinSettingsKey = JSON.stringify([board?.settings.theme, board?.settings.activeSkinRef, board?.settings.skinComponents, currentPage?.backgroundSkinRef]);
  const wallpaper = visibleWallpaper(board?.settings.wallpaper, currentPage);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);

  useEffect(() => {
    if (!board) return;
    const style = composedSkinStyle(skinManifests, board.settings.activeSkinRef, { ...board.settings.skinComponents, ...(currentPage?.backgroundSkinRef ? { background: currentPage.backgroundSkinRef } : {}) });
    document.documentElement.dataset.theme = String(style['--chrome-color-scheme'] ?? board.settings.theme);
    applySkinVariables(document.documentElement.style, style);
  }, [skinSettingsKey, skinManifests]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    selectedIdsRef.current = selectedIds;
    const selected = new Set(selectedIds);
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        const isSelected = selected.has(node.id);
        if (node.selected === isSelected && node.data.selected === isSelected) return node;
        changed = true;
        return { ...node, selected: isSelected, data: { ...node.data, selected: isSelected } };
      });
      return changed ? next : current;
    });
  }, [selectedId, selectedIds]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Alt') setAltPressed(true); };
    const onKeyUp = (event: KeyboardEvent) => { if (event.key === 'Alt') setAltPressed(false); };
    const onBlur = () => setAltPressed(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => { window.removeEventListener('keydown', onKeyDown); window.removeEventListener('keyup', onKeyUp); window.removeEventListener('blur', onBlur); };
  }, []);

  const globalCanvasRecords = useMemo(() => {
    const records = board ? visibleCanvasRecords(board) : [];
    for (const entry of noteSaver.entries.values()) {
      if (!records.some((r) => r.id === entry.record.id) && (entry.clientRequestId || entry.status !== 'saved')) records.push(entry.record);
    }
    return records.map(record => ({ ...noteSaver.overlay(record), ...priorityOnDate(record, priorityDate) }));
  }, [board, editTick, noteSaver, priorityDate]);
  const canvasRecords = useMemo(() => globalCanvasRecords.filter(record => pageId(record) === currentPageId), [globalCanvasRecords, currentPageId]);
  const globalMappedLinks = useMemo(() => board ? canvasLinks(board, globalCanvasRecords) : [], [board, globalCanvasRecords]);
  const mappedLinks = useMemo(() => { const ids = new Set(canvasRecords.map(record => record.id)); return globalMappedLinks.filter(link => ids.has(link.sourceNodeId) && ids.has(link.targetNodeId)); }, [globalMappedLinks, canvasRecords]);
  const folding = useMemo(() => foldedCanvasProjection(canvasRecords, mappedLinks), [canvasRecords, mappedLinks]);
  const canvasRecordMap = useMemo(() => new Map(canvasRecords.map((record) => [record.id, record])), [canvasRecords]);
  const visibleNodes = useMemo(() => {
    const all = nodes.filter(node => pageId(node.data.record) === currentPageId);
    for (const record of canvasRecords) if (!all.some((n) => n.id === record.id)) all.push({ id: record.id, type: 'bubble', ...canvasNodeGeometry(record), data: { record, annotationCount: 0, selected: false, canResize: false, onResizeEnd: persistResize } });
    return all.map((node) => {
    const sourceRecord = canvasRecordMap.get(node.id) || node.data.record;
    const scaling = selectionScale && selectionMoveRef.current?.nodes.find(item => item.id === node.id);
    const record = scaling ? scaledNodePreview(scaling, sourceRecord, selectionScale!) : sourceRecord;
    const componentId = node.data.record.kind === 'note' ? 'note' : 'taskBubble';
    const skinManifest = effectiveNodeSkinManifest(skinManifests, board, record, componentId);
    const eligibility = record.kind === 'note' ? getNoteFoldEligibility(node.id, canvasRecords, mappedLinks) : null;
    const animated = foldAnimation?.id === node.id;
    const host = animated ? canvasRecordMap.get(foldAnimation.hostId) : undefined;
    const actualLink = host ? mappedLinks.find((link) => link.sourceNodeId === record.id && link.targetNodeId === host.id || link.targetNodeId === record.id && link.sourceNodeId === host.id) : undefined;
    const noteRect = { ...record, shape: skinShape(skinManifest, componentId), cornerRadii: skinCornerRadii(skinManifest, componentId) };
    const hostSkin = host ? effectiveNodeSkinManifest(skinManifests, board, host, host.kind === 'note' ? 'note' : 'taskBubble') : undefined;
    const hostRect = host ? { ...host, shape: skinShape(hostSkin, host.kind === 'note' ? 'note' : 'taskBubble'), cornerRadii: skinCornerRadii(hostSkin, host.kind === 'note' ? 'note' : 'taskBubble') } : undefined;
    const noteIsSource = !actualLink || actualLink.sourceNodeId === record.id;
    const motionGeometry = hostRect ? floatingLinkGeometry(noteIsSource ? noteRect : hostRect, noteIsSource ? hostRect : noteRect, actualLink?.bend) : undefined;
    return {
      ...node,
      ...(scaling ? { width: record.width, height: record.height, measured: { width: record.width, height: record.height }, style: { ...node.style, width: record.width, height: record.height } } : {}),
      position: scaling ? { x: record.x, y: record.y } : selectionDelta && selectionMoveRef.current?.nodes.some((item) => item.id === node.id)
        ? { x: selectionMoveRef.current.nodes.find((item) => item.id === node.id)!.x + selectionDelta.x, y: selectionMoveRef.current.nodes.find((item) => item.id === node.id)!.y + selectionDelta.y }
        : node.position,
      hidden: (!animated && folding.hiddenIds.has(node.id)) || !matchesCanvasView({ ...node.data, record }, projectKey, lens),
      draggable: !readOnly && node.draggable,
      data: { ...node.data, record, isDraft: false, editing: !readOnly && editingNoteId === node.id, online: connection === 'online' && !readOnly, readOnly,
        canResize: !readOnly && node.data.canResize && selectedIds.length + selectedInkIds.length <= 1 && !selectionScale && !selectionAsGroup,
        imageDetail: Boolean(node.data.selected && selectedIds.length === 1 && selectedInkIds.length === 0),
        transforming: Boolean(selectionMoveRef.current?.nodes.some(item => item.id === node.id)),
        onNoteEdit: editNote, onNoteBlur: finishNote, onNoteComposition: (id: string, active: boolean) => noteSaver.composition(id, active),
        onFocusNote: openNoteFocus, onNotePanel: openNotePanel, onArchiveNote: archiveNote, priorityIcons: board?.settings.priorityIcons, dataStoreId: serviceHealth?.dataStoreId,
        singleSelection: node.id === selectedId && selectedIds.length === 1 && !selectedInkIds.length && !selectionAsGroup,
        unsavedDraft: Boolean(noteSaver.entries.get(record.id)?.clientRequestId) || record.id.startsWith('offline-note:'),
        onFoldAll: record.kind === 'task' ? (folded: boolean) => void foldAll(record.id, folded) : undefined,
        foldedCount: folding.hosted.get(record.id)?.length || 0,
        onFold: eligibility?.parentNodeId ? () => void changeFold(node.id, eligibility.parentNodeId) : undefined,
        foldAnimation: hostRect && motionGeometry ? { frames: foldMotionFrames(noteRect, hostRect, motionGeometry, noteIsSource), opening: foldAnimation!.opening } : undefined,
        onNotice: setNotice,
        skinStyle: nodeManifestSkinStyle(skinManifest, componentId), shape: skinShape(skinManifest, componentId), cornerRadii: skinCornerRadii(skinManifest, componentId),
        aspectLockedDefault: skinAspectLockedDefault(skinManifest, componentId), altPressed, onAspectLockChange: persistAspectLock }
    };
  }); }, [nodes, board, projectKey, lens, skinManifests, altPressed, canvasRecords, canvasRecordMap, mappedLinks, folding, editingNoteId, foldAnimation, selectionDelta, selectionScale, selectionAsGroup, selectedId, selectedIds.length, selectedInkIds.length, connection, currentPageId, readOnly, serviceHealth?.dataStoreId]);
  const filteredNoteCount = visibleNodes.filter(node => node.data.record.kind === 'note' && node.hidden && !folding.hiddenIds.has(node.id)).length;
  const displayedInk = useMemo(() => (board?.inkStrokes || []).filter(stroke => pageId(stroke) === currentPageId).map((stroke) => {
    const original = selectionMoveRef.current?.ink.find((item) => item.id === stroke.id);
    if (selectionScale && original) return scaledInk(original, selectionScale);
    return selectionDelta && original ? { ...stroke, points: original.points.map((p) => ({ ...p, x: p.x + selectionDelta.x, y: p.y + selectionDelta.y })) } : stroke;
  }), [board, selectionDelta, selectionScale, currentPageId]);
  const selectionRects = visibleNodes.filter((node) => !node.hidden && selectedIds.includes(node.id)).map((node) => ({ ...node.position, width: node.data.record.width, height: node.data.record.height }));
  const inkSelectionBounds = selectionBounds(displayedInk.filter((stroke) => selectedInkIds.includes(stroke.id)));
  if (inkSelectionBounds) selectionRects.push(inkSelectionBounds);
  const groupBounds = selectionRects.length ? {
    x: Math.min(...selectionRects.map((r) => r.x)), y: Math.min(...selectionRects.map((r) => r.y)),
    width: Math.max(...selectionRects.map((r) => r.x + r.width)) - Math.min(...selectionRects.map((r) => r.x)),
    height: Math.max(...selectionRects.map((r) => r.y + r.height)) - Math.min(...selectionRects.map((r) => r.y))
  } : null;
  const canvasShapeMap = useMemo(() => new Map(visibleNodes.map((node) => [node.id, { shape: node.data.shape, cornerRadii: node.data.cornerRadii }])), [visibleNodes]);
  const edges = useMemo<Edge[]>(() => folding.links.map((link) => {
    const highlighted = linkTouchesSelection(link, hoveredLinkNodeId ? [...selectedIds, hoveredLinkNodeId] : selectedIds);
    return {
      id: link.id, source: link.sourceNodeId, target: link.targetNodeId, type: 'floating',
      selected: selectedEdgeId === link.id,
      hidden: !visibleNodes.some((n) => n.id === link.sourceNodeId && !n.hidden) || !visibleNodes.some((n) => n.id === link.targetNodeId && !n.hidden),
      className: highlighted ? 'canvas-link is-highlighted' : 'canvas-link', interactionWidth: 28,
      data: { sourceKind: canvasRecordMap.get(link.sourceNodeId)?.kind || 'task', targetKind: canvasRecordMap.get(link.targetNodeId)?.kind || 'task',
        sourceShape: canvasShapeMap.get(link.sourceNodeId)?.shape, targetShape: canvasShapeMap.get(link.targetNodeId)?.shape,
        sourceCornerRadii: canvasShapeMap.get(link.sourceNodeId)?.cornerRadii, targetCornerRadii: canvasShapeMap.get(link.targetNodeId)?.cornerRadii, highlighted,
        bend: link.bend, onBendChange: changeLinkBend, onDelete: deleteLink, projectedLabel: link.projectedLabel },
      style: { stroke: highlighted ? 'var(--skin-link-highlight, var(--accent))' : 'var(--edge)', strokeWidth: highlighted ? 3 : 2, opacity: highlighted ? 1 : .82 }
    };
  }), [folding, selectedIds, selectedEdgeId, hoveredLinkNodeId, canvasRecordMap, canvasShapeMap, visibleNodes]);
  const selected = canvasRecords.find((node) => node.id === selectedId) || null;
  const focusedNote = noteFocusAnchor && selected?.kind === 'note' && !navigationOnly ? selected : null;
  const selectedProject = board && selected ? contextForNode(board, selected) : undefined;
  const selectedThread = board?.threads.find((thread) => thread.threadKey === selected?.threadKey);
  const annotationTargets = selectedProject?.memberNodeIds || (selected ? [selected.id] : []);
  const annotations = board?.annotations.filter((item) => annotationTargets.includes(item.targetNodeId)) || [];
  const archive = useMemo(() => archivedNotes((board?.nodes || []).filter(node => pageId(node) === currentPageId)), [board, currentPageId]);
  const archiveRelations = useMemo(() => board ? archivedNoteRelations(board).filter(relation => pageId(relation.note) === currentPageId) : [], [board, currentPageId]);
  const selectedArchiveRelations = useMemo(() => board && selected ? archivedRelationsForNode(board, selected) : [], [board, selected]);
  const hoveredNode = hoverPreview ? visibleNodes.find((node) => node.id === hoverPreview.nodeId && !node.hidden) : undefined;
  const activeInkManifest = useMemo(() => skinComponentManifest(skinManifests, board?.settings.activeSkinRef, 'inkPalette', board?.settings.skinComponents.inkPalette), [board?.settings.activeSkinRef, board?.settings.skinComponents.inkPalette, skinManifests]);
  const activeInkPalette = activeInkManifest && getSkinComponent(activeInkManifest, 'inkPalette');
  const inkPreset: InkPreset = inkTool === 'highlighter'
    ? { color: drawingPreferences.highlighterColor, size: drawingPreferences.highlighterSize, opacity: activeInkPalette && 'highlighterOpacity' in activeInkPalette ? activeInkPalette.highlighterOpacity : .26, layer: drawingPreferences.layer }
    : { color: drawingPreferences.penColor, size: drawingPreferences.penSize, opacity: 1, layer: drawingPreferences.layer };
  const stageBounds = stageRef.current?.getBoundingClientRect();
  const stageWidth = stageBounds?.width || window.innerWidth;
  const stageHeight = stageBounds?.height || window.innerHeight;
  const viewportBounds = useMemo(() => ({
    x: -canvasViewport.x / canvasViewport.zoom,
    y: -canvasViewport.y / canvasViewport.zoom,
    width: stageWidth / canvasViewport.zoom,
    height: stageHeight / canvasViewport.zoom
  }), [canvasViewport.x, canvasViewport.y, canvasViewport.zoom, stageHeight, stageWidth]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const typing = isTyping(event.target);
      const target = event.target instanceof Element ? event.target : null;
      // The feedback panel owns Escape and waits for its draft write before closing.
      if ((detail === 'feedback' || detail === 'guide' || detail === 'permissions' || detail === 'archive' || focusedNote) && !noteRecoveryOpen) return;
      const panelOpen = Boolean(notePanel);
      const overlayOpen = drawerOpen || panelOpen;
      if (exportOpen || event.code === 'Space') {
        if (!canvasBusy && !typing && startsCanvasPan(event, target, overlayOpen || noteRecoveryOpen)) {
          event.preventDefault(); setSpacePan(true);
        }
        return;
      }
      if (canvasBusy) { if (!typing) event.preventDefault(); return; }
      if (event.key === 'Escape') {
        if ((typing && !drawerOpen) || event.isComposing || event.keyCode === 229 || event.defaultPrevented || event.repeat) return;
        event.preventDefault();
        if (selectionMoveRef.current) { cancelSelectionMove(); return; }
        if (hoverNodeRef.current && !overlayOpen) { clearHoverPreview(); return; }
        if (noteRecoveryOpen) setNoteRecoveryOpen(false);
        else if (detail) backInMenu();
        else if (drawerOpen) closeBoardMenu();
        else if (notePanel) { if (!scheduleBusy) setNotePanel(null); }
        else if (selectedIdsRef.current.length) applySelection([]);
        else { setInkTool('select'); setSelectedInkIds([]); }
        return;
      }
      if (noteRecoveryOpen) return;
      if (!typing && !event.defaultPrevented && !event.isComposing && !event.repeat) {
        if (!panelOpen && shortcutMatches(event, shortcuts.menu)) {
          event.preventDefault(); toggleBoardMenu(); return;
        }
        // Panel controls keep their shortcuts even if the canvas still has a selected link or object.
        if (panelOwnsCanvasKeys(overlayOpen, target)) return;
        if (event.key === 'Enter' && !event.shiftKey && !overlayOpen && inkTool === 'select' && event.target instanceof HTMLElement && event.target.matches('.react-flow__node')) {
          const record = canvasRecordMap.get(event.target.dataset.id || '');
          if (record?.kind === 'note') {
            event.preventDefault();
            if (event.altKey) void openNoteFocus(record.id, event.target);
            else void chooseNode(record, false, event.target);
            return;
          }
        }
        if (selectedEdgeRef.current && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault(); void deleteLink(selectedEdgeRef.current); return;
        }
        if (!overlayOpen && inkTool === 'select' && (event.key === 'Backspace' || event.key === 'Delete') && (selectedInkIds.length || selectedIdsRef.current.length)) {
          if (!selectedInkIds.length && selectedIdsRef.current.length === 1 && selected?.kind === 'note') {
            if (shouldArchiveNote(event, selected, typing, overlayOpen)) {
              event.preventDefault(); void archiveNote(selected.id);
            }
            return;
          }
          event.preventDefault(); void deleteSelection(); return;
        }
        if (shortcutMatches(event, shortcuts.undo) || shortcutMatches(event, shortcuts.redo) || (event.ctrlKey && event.key.toLowerCase() === 'y')) {
          event.preventDefault();
          void runHistory(shortcutMatches(event, shortcuts.undo) ? 'undo' : 'redo');
          return;
        }
        if (!overlayOpen) {
          if (shortcutMatches(event, shortcuts.newNote)) { event.preventDefault(); startDraftNote(); return; }
          if (shortcutMatches(event, shortcuts.fitView)) { event.preventDefault(); void fitView({ padding: .24, duration: 350, maxZoom: 1 }); return; }
          const toolBindings: Array<[keyof Pick<ShortcutMap, 'selectTool' | 'penTool' | 'highlighterTool' | 'eraserTool' | 'lassoTool'>, InkCanvasTool]> = [
            ['selectTool', 'select'], ['penTool', 'pen'], ['highlighterTool', 'highlighter'], ['eraserTool', 'eraser'], ['lassoTool', 'lasso']
          ];
          const tool = toolBindings.find(([action]) => shortcutMatches(event, shortcuts[action]))?.[1];
          if (tool) { event.preventDefault(); setInkTool(tool); if (tool !== 'select') applySelection([]); return; }
          const priority = shortcutMatches(event, shortcuts.priority1) ? 'p1'
            : shortcutMatches(event, shortcuts.priority2) || shortcutMatches(event, shortcuts.priority3) ? 'p2'
            : shortcutMatches(event, shortcuts.priorityClear) ? null : undefined;
          if (priority !== undefined && selectedIdsRef.current.length > 0) {
            event.preventDefault(); void setSelectedPriority(priority); return;
          }
        }
      }
    };
    const keyup = (event: KeyboardEvent) => { if (event.code === 'Space') setSpacePan(false); };
    window.addEventListener('keydown', keyboard);
    window.addEventListener('keyup', keyup);
    return () => { window.removeEventListener('keydown', keyboard); window.removeEventListener('keyup', keyup); };
  });

  async function pasteCards(items: typeof failedPaste) {
    if (!writable()) return;
    if (pasteBusy.current) { setFailedPaste(previous => [...previous, ...items.filter(item => !previous.some(old => old.requestId === item.requestId))]); return setNotice('正在添加图片；这次粘贴已保留，请稍后点重试。'); }
    if (connectionRef.current !== 'online') return setNotice('当前离线，恢复连接后再粘贴图片。');
    pasteBusy.current = true; setFailedPaste(previous => previous.filter(item => !items.some(next => next.requestId === item.requestId)));
    const remaining = [...items];
    let created = false;
    try {
      while (remaining.length) {
        setNotice(`正在添加图片… 还有 ${remaining.length} 张`);
        const item = remaining[0]!;
        const sourcePage = boardRef.current && boardPages(boardRef.current).find(page => page.id === item.pageId);
        if (!sourcePage || sourcePage.archivedAt) throw new Error('图片的原页面已归档或不存在；重试内容仍保留，请先恢复原页面。');
        const asset = await uploadImage(item.file);
        const ratio = Math.min(1, 420 / Math.max(asset.width, asset.height));
        await api.createNote({ pageId: item.pageId, title: '', body: '', notePresentation: 'image', noteDocument: { version: 1, content: [{ type: 'image', assetId: asset.id, side: 'right', width: 100 }] },
          x: item.x, y: item.y, width: Math.max(112, asset.width * ratio), height: Math.max(88, asset.height * ratio), clientRequestId: item.requestId });
        remaining.shift(); created = true;
      }
      flashNotice('图片已放到画布，可移动、连线或归档；双击查看原图。');
    } catch (error) { setFailedPaste(previous => [...previous, ...remaining.filter(item => !previous.some(old => old.requestId === item.requestId))]); setNotice(error instanceof Error ? error.message : '图片未能添加，请重试。'); }
    finally { try { if (created) await reload(); } finally { pasteBusy.current = false; } }
  }
  useEffect(() => {
    const inPanel = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('.panel-shell, .modal-backdrop, .image-viewer, .control-drawer'));
    const copy = (event: ClipboardEvent) => {
      if (!selected || selected.kind !== 'note' || selectedIds.length !== 1 || selectedInkIds.length || !event.clipboardData ||
          event.defaultPrevented || focusedNote || exportOpen || drawerOpen || inPanel(event.target) || window.getSelection()?.isCollapsed === false) return;
      if (isTyping(event.target) && !(event.target instanceof Element && event.target.closest('.bubble.is-editing .note-rich-editor'))) return;
      event.preventDefault();
      try {
        const data = noteClipboardData(noteSaver.overlay(selected), serviceHealth?.dataStoreId);
        for (const [type, value] of Object.entries(data)) event.clipboardData.setData(type, value);
        flashNotice('已复制整张便签。');
      } catch (error) { setNotice(errorMessage(error)); }
    };
    const paste = (event: ClipboardEvent) => {
      if (!event.clipboardData || event.defaultPrevented || isTyping(event.target) || inPanel(event.target) || focusedNote || exportOpen || drawerOpen) return;
      const bounds = stageRef.current?.getBoundingClientRect();
      const point = screenToFlowPosition(lastCanvasPointer.current || { x: (bounds?.left || 0) + (bounds?.width || window.innerWidth) / 2, y: (bounds?.top || 0) + (bounds?.height || window.innerHeight) / 2 });
      try {
        const card = pastedNoteCard(event.clipboardData, serviceHealth?.dataStoreId);
        const files = card ? [] : clipboardImages(event.clipboardData);
        const body = event.clipboardData.getData('text/plain');
        if (!card && !files.length && !body) return;
        event.preventDefault();
        if (!writable()) return;
        if (card) void startDraftNote(point, card);
        else if (files.length) void pasteCards(files.map((file, index) => ({ file, pageId: currentPageRef.current, x: point.x + index * 24, y: point.y + index * 24, requestId: crypto.randomUUID() })));
        else if (body.length > 20_000) setNotice('每张便签最多 20000 字符，请分段粘贴。');
        else void startDraftNote(point, { title: '', body, width: 220, height: 150 });
      } catch (error) { event.preventDefault(); setNotice(errorMessage(error)); }
    };
    window.addEventListener('copy', copy); window.addEventListener('paste', paste);
    return () => { window.removeEventListener('copy', copy); window.removeEventListener('paste', paste); };
  });

  function focusThread(threadKey: string, fromMenu = false) {
    const current = boardRef.current;
    const target = current && projectNodeForThread(current, threadKey);
    if (!target) return setNotice('当前看板没有这条来源对话。');
    void locateRecord(target, threadKey, fromMenu);
  }


  async function setSelectedPriority(manualPriority: CanvasNodeRecord['manualPriority']) {
    if (!writable()) return;
    const currentBoard = boardRef.current;
    if (!currentBoard || !selectedIdsRef.current.length) return;
    if (connectionRef.current !== 'online') return setNotice('恢复本地服务后再调整优先级。');
    const records = selectedIdsRef.current.map((id) => currentBoard.nodes.find((node) => node.id === id));
    if (records.some((record) => !record || record.archivedAt || record.id.startsWith('offline-note:'))) {
      return setNotice('当前选择包含草稿、离线便签或只读占位，暂不能批量设置优先级。');
    }
    try {
      await api.setNodePriorities(records.map((record) => ({ id: record!.id, revision: record!.revision, manualPriority: manualPriority ?? null })));
      await reload();
      flashNotice(manualPriority ? `已把 ${records.length} 项设为 ${manualPriorityLabel(manualPriority)}。` : `已清除 ${records.length} 项的手动优先级。`);
    } catch (error) {
      handleMutationError(error);
      await reload().catch(() => undefined);
    }
  }

  async function saveNoteArrangement(original: CanvasNodeRecord, manualPriority: CanvasNodeRecord['manualPriority'], noteSchedule: NoteSchedule | null) {
    if (connectionRef.current !== 'online' || readOnlyRef.current) throw new Error('请在联网的可编辑页面保存安排。');
    if (noteSaver.isComposing(original.id) || !await noteSaver.flush(original.id)) throw new Error('请先完成正文输入或处理本机草稿。');
    const current = boardRef.current?.nodes.find(node => node.id === original.id);
    if (!current || current.archivedAt || currentPageRef.current !== pageId(current)) throw new Error('这张便签已移动或归档，请重新打开。');
    if (current.manualPriority !== original.manualPriority || JSON.stringify(current.noteSchedule ?? null) !== JSON.stringify(original.noteSchedule ?? null))
      throw new Error('其他编辑已调整这张便签的安排。请取消后重新打开安排。');
    try {
      await api.setNodePriorities([{ id: current.id, revision: current.revision, manualPriority: manualPriority ?? null, noteSchedule }]);
    } catch (error) {
      await reload().catch(() => undefined);
      if (error && typeof error === 'object' && 'status' in error && error.status === 409) throw new Error('便签已有其他变更。请核对后重试。');
      throw error;
    }
    await reload().catch(handleMutationError);
  }

  function persistResize(id: string, width: number, height: number, sourceEvent?: unknown) {
    if (!writable()) return;
    if (touchViewportRef.current?.isActive() || touchViewportRef.current?.isConsumed(sourceEvent)) return;
    const record = boardRef.current?.nodes.find((node) => node.id === id);
    if (!record) return;
    if (id.startsWith('offline-note:')) {
      void updateOfflineNote(id, { width, height });
      return;
    }
    if (connectionRef.current !== 'online') {
      setNotice('离线时先保留浏览与新便签；已有内容会在服务恢复后再编辑。');
      return;
    }
    api.updateNode(id, { width, height, revision: record.revision }).then(() => reload()).catch(handleMutationError);
  }

  function persistAspectLock(id: string, locked: boolean) {
    if (!writable()) return;
    const record = boardRef.current?.nodes.find((node) => node.id === id);
    if (!record || id.startsWith('offline-note:')) {
      setNotice('离线便签暂不保存比例锁；连接后可再次设置。');
      return;
    }
    if (connectionRef.current !== 'online') {
      setNotice('恢复本地服务后再保存比例锁。');
      return;
    }
    api.updateNode(id, { aspectLocked: locked, revision: record.revision })
      .then(() => reload())
      .catch((error) => { handleMutationError(error); void reload().catch(() => undefined); });
  }

  async function startDraftNote(position?: { x: number; y: number }, content?: NoteCardContent) {
    if (!writable()) return;
    const sourcePageId = currentPageRef.current;
    if (!await finishCanvasEditors() || sourcePageId !== currentPageRef.current) return;
    const center = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    const place = position || { x: center.x - 110, y: center.y - 75 };
    applySelection([]); setMenu(null);
    setProjectKey('all'); setLens('all');
    const now = new Date().toISOString();
    const requestId = crypto.randomUUID();
    const record: CanvasNodeRecord = {
      id: await noteRequestNodeId(requestId), kind: 'note', threadKey: null, pageId: sourcePageId,
      x: place.x, y: place.y, width: 220, height: 150, zIndex: 40,
      title: '', body: '', ...content, lastViewedAt: null, revision: 0, createdAt: now, updatedAt: now
    };
    noteSaver.edit(record, record.body, requestId, record.noteDocument);
    if (currentPageRef.current === sourcePageId) { setNavigationOnly(false); applySelection([record.id]); setEditingNoteId(content ? null : record.id); }
    setNodes((current) => {
      const next = [...current, {
        id: record.id, type: 'bubble' as const, ...canvasNodeGeometry(record), zIndex: record.zIndex,
        draggable: true,
        data: { record, annotationCount: 0, selected: false, canResize: false, isDraft: true, onResizeEnd: persistResize }
      }];
      nodesRef.current = next;
      return next;
    });
  }

  function editNote(id: string, body: string, document?: NoteDocument | null) {
    if (!writable()) return;
    const record = boardRef.current?.nodes.find((n) => n.id === id) || noteSaver.entries.get(id)?.record;
    if (!record) return;
    if (id.startsWith('offline-note:')) { void updateOfflineNote(id, { body, ...(document !== undefined ? { noteDocument: document } : {}) }); return; }
    noteSaver.edit(record, body, undefined, document);
  }

  function finishNote(id: string, finalBody?: string) {
    if (finalBody !== undefined) editNote(id, finalBody);
    setEditingNoteId((current) => current === id ? null : current);
    void noteSaver.finishEditing(id, finalBody);
  }

  async function resolveNoteConflict(id: string, keepLocal: boolean) {
    try {
      const fresh = await api.board();
      const remote = fresh.nodes.find((n) => n.id === id);
      if (!remote || remote.archivedAt) return setNotice('这张便签已删除或归档；恢复草稿仍保留，请复制文字后处理。');
      noteSaver.resolve(id, remote, keepLocal);
    } catch (error) { handleMutationError(error); }
  }

  async function changeFold(id: string, parentId: string | null) {
    if (!writable()) return;
    if (foldBusy.current || connectionRef.current !== 'online') return setNotice('请等待保存完成或恢复本地服务后再收纳。');
    foldBusy.current = true;
    try {
      if (!await finishCanvasEditors()) return;
      if (!await noteSaver.finish(id)) return setNotice('便签尚未保存；请先处理保存状态再收纳。');
      const record = boardRef.current?.nodes.find((n) => n.id === id);
      if (!record) return;
      const current = boardRef.current!;
      const projected = visibleCanvasRecords(current);
      const hostId = parentId || visibleFoldHost(id, projected, canvasLinks(current, projected));
      if (!hostId) return;
      setEditingNoteId(null);
      if (parentId) {
        setFoldAnimation({ id, hostId, opening: false });
        await new Promise((resolve) => window.setTimeout(resolve, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 300));
      }
      await api.updateNode(id, { foldedIntoNodeId: parentId, revision: record.revision });
      if (!parentId) setFoldAnimation({ id, hostId, opening: true });
      await reload();
      if (!parentId) await new Promise((resolve) => window.setTimeout(resolve, 300));
      applySelection([]);
    } catch (error) { handleMutationError(error); }
    finally { setFoldAnimation(null); foldBusy.current = false; }
  }

  function selectEdge(id: string, preservePanel = false) {
    if (!preservePanel) applySelection([]);
    setSelectedInkIds([]);
    selectedEdgeRef.current = id; setSelectedEdgeId(id);
  }
  async function changeLinkBend(id: string, bend: { along: number; normal: number } | null) {
    if (!writable()) return;
    const link = boardRef.current?.links.find((l) => l.id === id);
    if (!link || connectionRef.current !== 'online') return setNotice('恢复本地服务后再编辑连线。');
    try { await api.updateLink(id, { bend, revision: link.revision }); await reload(); }
    catch (error) { handleMutationError(error); }
  }
  async function deleteLink(id: string) {
    if (!writable()) return;
    const link = boardRef.current?.links.find((l) => l.id === id);
    if (!link || connectionRef.current !== 'online') return setNotice('恢复本地服务后再删除连线。');
    try {
      await api.deleteLink(id, link.revision); selectedEdgeRef.current = null; setSelectedEdgeId(null);
      await reload(); flashNotice('连线已删除，可撤销。');
    } catch (error) { handleMutationError(error); }
  }

  async function updateOfflineNote(id: string, patch: Partial<EditableNoteDraft>): Promise<boolean> {
    if (!writable()) return false;
    const currentBoard = boardRef.current;
    if (!currentBoard) return false;
    try {
      await updateQueuedNote(id, patch);
      const next = patchQueuedNode(currentBoard, id, patch);
      boardRef.current = next;
      setBoard(next);
      setNodes(toFlowNodes(next, selectedIdsRef.current, persistResize, true));
      setCachedAt(await saveBoardCache(next));
      return true;
    } catch (error) {
      showError(new Error(`离线便签未能更新：${errorMessage(error)}`));
      return false;
    }
  }

  const onNodesChange = useCallback((changes: NodeChange<Node<BubbleData>>[]) => setNodes((current) => {
    const allowed = changes.filter((change) => change.type !== 'remove' && change.type !== 'select'
      && !((change.type === 'position' || change.type === 'dimensions' && change.resizing !== undefined) && touchViewportRef.current?.blocksNodeChanges()));
    if (!allowed.length) return current;
    const next = applyNodeChanges(allowed, current);
    nodesRef.current = next;
    return next;
  }), []);
  async function openNoteFocus(id: string, anchor: HTMLElement) {
    if (!await finishCanvasEditors() || !anchor.isConnected || !canvasRecordMap.has(id) || currentPageRef.current !== pageId(canvasRecordMap.get(id)!)) return;
    clearHoverPreview();
    if (editingNoteId) finishNote(editingNoteId);
    setEditingNoteId(null); setNavigationOnly(false);
    applySelection([id]); setSelectedInkIds([]); setNoteFocusAnchor(anchor);
  }

  async function openNotePanel(id: string, panel: 'details' | 'schedule') {
    if (!await finishCanvasEditors() || selectedIdRef.current !== id) return;
    clearHoverPreview();
    if (editingNoteId) finishNote(editingNoteId);
    setNavigationOnly(false); setNotePanel(panel);
  }

  async function chooseNode(record: CanvasNodeRecord, additive: boolean, anchor: HTMLElement, editBody = true) {
    clearHoverPreview();
    if (editingNoteId === record.id && !additive && editBody) return;
    if (editingNoteId && !await finishCanvasEditors()) return;
    if (!anchor.isConnected || pageId(record) !== currentPageRef.current) return;
    if (editingNoteId) finishNote(editingNoteId);
    setNavigationOnly(false);
    if (!additive) setSelectedInkIds([]);
    const next = selectionAfterClick(selectedIdsRef.current, record.id, additive);
    applySelection(next, next.includes(record.id) ? record.id : next.at(-1) || null);
    if (!additive && record.kind === 'note') {
      if (editBody && !readOnly && record.notePresentation !== 'image') setEditingNoteId(record.id);
      else anchor.focus({ preventScroll: true });
    }
    setThreadToLocate(null);
  }
  const onNodeClick: NodeMouseHandler<Node<BubbleData>> = (event, node) => {
    if (node.data.isDraft || inkTool !== 'select' || spacePan || exportOpen || !(event.currentTarget instanceof HTMLElement)) return;
    const record = node.data.record;
    const empty = !record.body && !record.noteDocument?.content.some(item => item.type === 'image');
    const editBody = empty || event.target instanceof Element && Boolean(event.target.closest('.note-document, .note-editor-host'));
    void chooseNode(record, event.shiftKey, event.currentTarget, editBody);
  };
  const onNodeContextMenu: NodeMouseHandler<Node<BubbleData>> = (event, node) => {
    event.preventDefault();
    event.stopPropagation();
    clearHoverPreview();
    if (node.data.isDraft) return setNotice('先保存这张便签，再把它连接到其他内容。');
    const current = selectedIdsRef.current;
    if (current.length === 0) {
      applySelection([node.id], node.id);
      setThreadToLocate(null);
      setNotice(`已把「${bubbleLabel(node)}」设为连接起点；再右键另一个气泡或便签。`);
      return;
    }
    if (current.length > 1) return setNotice('建立连线前请只保留一个连接起点。');
    if (current[0] === node.id) return setNotice('这是连接起点；请右键另一个气泡或便签。');
    void addLink(node.id);
  };
  const onNodeDragStop: OnNodeDrag<Node<BubbleData>> = (_event, node) => {
    if (touchViewportRef.current?.isActive() || touchViewportRef.current?.isConsumed(_event)) return;
    clearHoverPreview();
    const origin = selectionMoveRef.current?.nodes.find((item) => item.id === node.id);
    if (origin) void finishSelectionMove({ x: node.position.x - origin.x, y: node.position.y - origin.y });
    else if (nodeDragModeRef.current === 'offline') void persistDraggedSelection(node.id);
    else if (boardRef.current) setNodes(toFlowNodes(boardRef.current, selectedIdsRef.current, persistResize, connectionRef.current !== 'online'));
    nodeDragModeRef.current = null;
  };

  function isBubbleControl(target: EventTarget | null) {
    return target instanceof Element && Boolean(target.closest('button, .note-tools, .note-scroll-rail, .project-fold-tools, [contenteditable="true"], .react-flow__handle, .react-flow__resize-control'));
  }
  const onNodeMouseEnter: NodeMouseHandler<Node<BubbleData>> = (event, node) => {
    if (node.data.isDraft || marqueeRef.current || focusedNote || exportOpen || isBubbleControl(event.target)) return;
    clearHoverPreview();
    setHoveredLinkNodeId(node.id);
    hoverNodeRef.current = node.id;
    const point = previewPoint(event.clientX, event.clientY);
    hoverTimerRef.current = window.setTimeout(() => {
      if (hoverNodeRef.current === node.id) setHoverPreview({ nodeId: node.id, ...point });
    }, 360);
  };
  const onNodeMouseMove: NodeMouseHandler<Node<BubbleData>> = (event, node) => {
    if (isBubbleControl(event.target)) {
      if (hoverNodeRef.current) clearHoverPreview();
      return;
    }
    if (!hoverNodeRef.current) { onNodeMouseEnter(event, node); return; }
    if (hoverPreview?.nodeId !== node.id) return;
    setHoverPreview({ nodeId: node.id, ...previewPoint(event.clientX, event.clientY) });
  };
  const onNodeMouseLeave: NodeMouseHandler<Node<BubbleData>> = () => clearHoverPreview();

  const describedNodeId = hoveredNode?.id;
  useEffect(() => {
    if (!describedNodeId) return;
    const element = stageRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(describedNodeId)}"]`);
    if (!element) return;
    const previous = element.getAttribute('aria-describedby');
    element.setAttribute('aria-describedby', [previous, 'canvas-bubble-preview'].filter(Boolean).join(' '));
    return () => {
      if (previous) element.setAttribute('aria-describedby', previous);
      else element.removeAttribute('aria-describedby');
    };
  }, [describedNodeId]);

  function clearHoverPreview() {
    hoverNodeRef.current = null;
    setHoveredLinkNodeId(null);
    if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setHoverPreview(null);
  }

  function previewPoint(clientX: number, clientY: number) {
    return {
      x: Math.max(12, Math.min(clientX + 18, window.innerWidth - 338)),
      y: Math.max(12, Math.min(clientY + 16, window.innerHeight - 252))
    };
  }

  function trackScale(viewport: Viewport) {
    const next = isBroadScale(viewport.zoom, broadScaleRef.current);
    if (next === broadScaleRef.current) return;
    broadScaleRef.current = next;
    setBroadScale(next);
  }

  function queueViewportSave(viewport: Viewport) {
    const current = boardRef.current;
    if (current && !readOnlyRef.current) {
      const next = { ...current, pages: boardPages(current).map(page => page.id === currentPageRef.current ? { ...page, viewport } : page) };
      boardRef.current = next; setBoard(next); void saveBoardCache(next).then(setCachedAt).catch(() => undefined);
    }
    viewportSaver.current?.queue(viewport);
  }

  function beginMarquee(event: ReactPointerEvent<HTMLElement>) {
    if (inkTool !== 'select' || spacePan) return;
    if (event.button !== 2 || !(event.target instanceof Element)) return;
    if (!event.target.closest('.react-flow__pane') || event.target.closest('.react-flow__node, .react-flow__controls, .react-flow__minimap')) return;
    event.preventDefault();
    event.stopPropagation();
    clearHoverPreview();
    marqueeRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY, additive: event.shiftKey };
    event.currentTarget.setPointerCapture(event.pointerId);
    setMarquee(dragRect(event.clientX, event.clientY, event.clientX, event.clientY));
  }

  function moveMarquee(event: ReactPointerEvent<HTMLElement>) {
    const active = marqueeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    active.currentX = event.clientX;
    active.currentY = event.clientY;
    setMarquee(dragRect(active.startX, active.startY, active.currentX, active.currentY));
  }

  function finishMarquee(event: ReactPointerEvent<HTMLElement>) {
    const active = marqueeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const rectangle = dragRect(active.startX, active.startY, event.clientX, event.clientY);
    const moved = Math.hypot(event.clientX - active.startX, event.clientY - active.startY) >= 4;
    marqueeRef.current = null;
    setMarquee(null);
    if (!moved || !stageRef.current) return;
    const visibleIds = new Set(visibleNodes.filter((node) => !node.hidden).map((node) => node.id));
    const hits = [...stageRef.current.querySelectorAll<HTMLElement>('.react-flow__node')]
      .filter((element) => Boolean(element.dataset.id && visibleIds.has(element.dataset.id)))
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && intersectsRect(rectangle, bounds);
      })
      .map((element) => element.dataset.id!);
    const next = selectionAfterMarquee(selectedIdsRef.current, hits, active.additive);
    applySelection(next, hits.at(-1) || (active.additive ? selectedIdRef.current : null));
    setSelectionAsGroup(true);
    setThreadToLocate(null);
  }

  function cancelMarquee(event: ReactPointerEvent<HTMLElement>) {
    const active = marqueeRef.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    marqueeRef.current = null;
    setMarquee(null);
  }

  async function persistDraggedSelection(draggedId: string) {
    const currentBoard = boardRef.current;
    if (!currentBoard) return;
    const ids = selectedIdsRef.current.includes(draggedId) ? selectedIdsRef.current : [draggedId];
    const liveNodes = ids.map((id) => nodesRef.current.find((node) => node.id === id)).filter((node): node is Node<BubbleData> => Boolean(node));
    const changed = liveNodes.filter((node) => {
      const record = currentBoard.nodes.find((item) => item.id === node.id);
      return record && (record.x !== node.position.x || record.y !== node.position.y);
    });
    if (!changed.length) return;
    if (connectionRef.current !== 'online') {
      for (const node of changed.filter((item) => item.id.startsWith('offline-note:'))) {
        await updateOfflineNote(node.id, { x: node.position.x, y: node.position.y });
      }
      const latest = boardRef.current || currentBoard;
      setNodes(toFlowNodes(latest, selectedIdsRef.current, persistResize, true));
      setNotice('离线浏览中：已同步便签保留原位；离线新便签的位置已安全保存。');
      return;
    }
    try {
      for (const node of changed.filter((item) => item.id.startsWith('offline-note:'))) {
        await updateOfflineNote(node.id, { x: node.position.x, y: node.position.y });
      }
      const persisted = changed.filter((item) => !item.id.startsWith('offline-note:')).map((node) => {
        const record = currentBoard.nodes.find((item) => item.id === node.id)!;
        return { id: node.id, patch: { x: node.position.x, y: node.position.y, revision: record.revision } };
      });
      if (persisted.length) await api.updateNodes(persisted);
      await reload();
    } catch (error) {
      handleMutationError(error);
      await reload().catch(() => undefined);
    }
  }

  function beginSelectionMove(nodeIds = selectedIdsRef.current, inkIds = selectedInkIds): boolean {
    if (!writable()) return false;
    if (selectionBusyRef.current || selectionMoveRef.current || historyBusyRef.current || connectionRef.current !== 'online') { setNotice('请等待保存完成或恢复本地服务后再移动。'); return false; }
    const current = boardRef.current;
    if (!current) return false;
    const records = nodeIds.map((id) => current.nodes.find((node) => node.id === id));
    const strokes = inkIds.map((id) => current.inkStrokes.find((stroke) => stroke.id === id));
    if (records.some((node) => !node || node.archivedAt || node.foldedIntoNodeId || node.id.startsWith('offline-note:')) || strokes.some((stroke) => !stroke)) {
      setNotice('选区包含未同步或已隐藏的内容，请先完成同步。'); return false;
    }
    selectionMoveRef.current = { nodes: records as CanvasNodeRecord[], ink: strokes as InkStrokeRecord[] };
    setSelectionDelta({ x: 0, y: 0 });
    return true;
  }

  function cancelSelectionMove() {
    if (selectionBusyRef.current) return;
    selectionMoveRef.current = null; setSelectionDelta(null); setSelectionScale(null);
    if (boardRef.current) setNodes(toFlowNodes(boardRef.current, selectedIdsRef.current, persistResize, connectionRef.current !== 'online'));
  }

  async function flushSelectionNotes(ids: string[]): Promise<boolean> {
    const saved = await Promise.all(ids.map((id) => noteSaver.finish(id)));
    if (saved.some((ok) => !ok)) { setNoteRecoveryOpen(true); setNotice('选区内有便签尚未保存，未执行这次操作。'); return false; }
    return true;
  }

  async function finishSelectionMove(delta: { x: number; y: number }) {
    const gesture = selectionMoveRef.current;
    if (!gesture || selectionBusyRef.current) return;
    if (!delta.x && !delta.y) { cancelSelectionMove(); return; }
    selectionBusyRef.current = true; setCanvasBusy(true); setSelectionDelta(delta);
    try {
      if (!await flushSelectionNotes(gesture.nodes.map((node) => node.id))) return;
      const records = gesture.nodes.map((original) => {
        const latest = boardRef.current?.nodes.find((node) => node.id === original.id);
        if (!latest || latest.x !== original.x || latest.y !== original.y) throw new Error('选区的位置已被另一处修改，本次移动未保存，请重新选择。');
        return { id: latest.id, revision: latest.revision };
      });
      await api.selection({ action: 'translate', nodes: records, ink: gesture.ink.map(({ id, revision }) => ({ id, revision })), delta });
      mutationEpoch.current++;
      await reload();
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { selectionBusyRef.current = false; setCanvasBusy(false); cancelSelectionMove(); }
  }

  function beginSelectionScale() {
    if (!beginSelectionMove()) return null;
    setEditingNoteId(null);
    const gesture = selectionMoveRef.current!;
    return selectionScaleLimits(gesture.nodes, gesture.ink);
  }

  async function finishSelectionScale(transform: SelectionScale) {
    const gesture = selectionMoveRef.current;
    if (!gesture || selectionBusyRef.current) return;
    if (Math.abs(transform.factor - 1) < 1e-9) { cancelSelectionMove(); return; }
    selectionBusyRef.current = true; setCanvasBusy(true); setSelectionScale(transform);
    try {
      if (!await flushSelectionNotes(gesture.nodes.map(node => node.id))) return;
      const refs = gesture.nodes.map(original => {
        const latest = boardRef.current?.nodes.find(node => node.id === original.id);
        if (!latest || ['x', 'y', 'width', 'height'].some(key => latest[key as 'x'] !== original[key as 'x']) || (latest.contentScale ?? 1) !== (original.contentScale ?? 1)) throw new Error('选区已被另一处调整，本次缩放未保存，请重新选择。');
        return { id: latest.id, revision: latest.revision };
      });
      await api.selection({ action: 'scale', nodes: refs, ink: gesture.ink.map(({ id, revision }) => ({ id, revision })), ...transform });
      mutationEpoch.current++; await reload();
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { selectionBusyRef.current = false; setCanvasBusy(false); cancelSelectionMove(); }
  }

  async function deleteSelection(inkIds = selectedInkIds) {
    if (!writable()) return;
    if (selectionBusyRef.current || historyBusyRef.current) return;
    if (connectionRef.current !== 'online') return setNotice('恢复本地服务后再处理选区。');
    const ids = [...selectedIdsRef.current];
    if (!ids.length && !inkIds.length) return;
    selectionBusyRef.current = true; setCanvasBusy(true);
    try {
      if (!await flushSelectionNotes(ids)) return;
      const current = boardRef.current!;
      const refs = ids.map((id) => {
        const node = current.nodes.find((n) => n.id === id);
        if (!node || id.startsWith('offline-note:')) throw new Error('选区包含未同步便签，本次操作未执行。');
        return { id, revision: node.revision };
      });
      const ink = inkIds.map((id) => {
        const stroke = current.inkStrokes.find((item) => item.id === id);
        if (!stroke) throw new Error('选区内墨迹尚未保存或已经变化，请重新选择。');
        return { id, revision: stroke.revision };
      });
      const result = await api.selection({ action: 'delete', nodes: refs, ink });
      mutationEpoch.current++;
      for (const id of result.archivedNoteIds) if (!noteSaver.dirty(id)) noteSaver.discard(id);
      applySelection(result.keptNodeIds); setSelectedInkIds([]);
      await reload();
      flashNotice(`已删除 ${result.deletedInkIds.length} 条墨迹、归档 ${result.archivedNoteIds.length} 张便签；保留 ${result.keptNodeIds.length} 个项目气泡。${result.deletedInkIds.length || result.archivedNoteIds.length ? '可一次撤销。' : ''}`);
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { selectionBusyRef.current = false; setCanvasBusy(false); }
  }

  async function runHistory(direction: 'undo' | 'redo') {
    if (connectionRef.current !== 'online') return setNotice('恢复本地服务后再使用撤销与重做。');
    if (historyBusyRef.current || selectionBusyRef.current || selectionMoveRef.current) return;
    historyBusyRef.current = true; setCanvasBusy(true);
    try {
    await reload();
    const saved = await noteSaver.flushAll();
    if (saved.some((ok) => !ok)) { setNoteRecoveryOpen(true); return setNotice('有便签草稿待处理，已打开恢复面板。'); }
    await reload();
    const status = boardRef.current?.historyStatus;
    if (direction === 'undo' && !status?.canUndo) return setNotice('没有可撤销的操作。');
    if (direction === 'redo' && !status?.canRedo) return setNotice('没有可重做的操作。');
      const result = await (direction === 'undo' ? api.undo() : api.redo());
      for (const [id] of noteSaver.entries) if (!noteSaver.dirty(id)) noteSaver.discard(id);
      applySelection([]); setSelectedInkIds([]);
      await reload();
      if (result.focusPageId) await switchPage(result.focusPageId);
      setNavigationOnly(true);
      flashNotice(direction === 'undo' ? `已撤销：${status?.undoLabel || '上一步'}` : `已重做：${status?.redoLabel || '下一步'}`);
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { historyBusyRef.current = false; setCanvasBusy(false); }
  }

  function selectInk(ids: string[], mode: 'replace' | 'add' | 'toggle') {
    if (mode === 'replace' && ids.length > 0) applySelection([]);
    setSelectedInkIds((current) => {
      if (mode === 'replace') return [...new Set(ids)];
      if (mode === 'add') return [...new Set([...current, ...ids])];
      const toggled = new Set(current);
      ids.forEach((id) => toggled.has(id) ? toggled.delete(id) : toggled.add(id));
      return [...toggled];
    });
  }

  async function createInkStroke(stroke: NewInkStroke) {
    if (!writable()) throw new Error('归档页面只读。');
    const sourcePageId = currentPageRef.current;
    if (connectionRef.current !== 'online') throw new Error('本地服务尚未连接；笔迹暂留画布，连接后可重试。');
    try {
      const saved = await api.createInkStroke({ ...stroke, pageId: sourcePageId });
      mutationEpoch.current++;
      const current = boardRef.current;
      if (current && !current.inkStrokes.some((s) => s.id === saved.id)) {
        const next = { ...current, inkStrokes: [...current.inkStrokes, saved] };
        boardRef.current = next; setBoard(next);
      }
      window.setTimeout(() => { void reload().catch(handleMutationError); }, 150);
    } catch (error) { handleMutationError(error); throw error; }
  }

  async function eraseInk(actions: InkEraseAction[]) {
    if (!writable()) return;
    const current = boardRef.current;
    if (!current || connectionRef.current !== 'online') return;
    const creates: Parameters<typeof api.applyInkBatch>[0]['creates'] = [];
    const updates: Parameters<typeof api.applyInkBatch>[0]['updates'] = [];
    const deletes: Parameters<typeof api.applyInkBatch>[0]['deletes'] = [];
    for (const action of actions) {
      const stroke = current.inkStrokes.find((item) => item.id === action.strokeId);
      if (!stroke) continue;
      if (action.mode === 'whole' || action.remaining.length === 0) {
        deletes.push({ id: stroke.id, revision: stroke.revision });
        continue;
      }
      updates.push({ id: stroke.id, patch: { points: action.remaining[0]!, revision: stroke.revision } });
      action.remaining.slice(1).filter((points) => points.length > 0).forEach((points) => creates.push({
        pageId: pageId(stroke), tool: stroke.tool, points, color: stroke.color, size: stroke.size, opacity: stroke.opacity, layer: stroke.layer, zIndex: stroke.zIndex
      }));
    }
    if (creates.length + updates.length + deletes.length === 0) return;
    try { await api.applyInkBatch({ creates, updates, deletes }); setSelectedInkIds([]); await reload(); }
    catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
  }

  async function transformInk(updates: InkTransformUpdate[]) {
    if (!writable()) return;
    if (!updates.length || connectionRef.current !== 'online') return;
    try {
      await api.applyInkBatch({ creates: [], updates: updates.map(({ id, revision, points, size }) => ({ id, patch: { revision, points, size } })), deletes: [] });
      await reload();
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
  }

  async function styleInk(ids: string[], patch: { color?: string; layer?: 'background' | 'foreground' }) {
    if (!writable()) return;
    const current = boardRef.current;
    if (!current || connectionRef.current !== 'online') return;
    const updates = ids.flatMap((id) => {
      const stroke = current.inkStrokes.find((item) => item.id === id);
      return stroke ? [{ id, patch: { ...patch, revision: stroke.revision } }] : [];
    });
    if (!updates.length) return;
    try { await api.applyInkBatch({ creates: [], updates, deletes: [] }); await reload(); }
    catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
  }

  function updateInkPreset(preset: InkPreset) {
    const next: DrawingPreferences = inkTool === 'highlighter'
      ? { ...drawingPreferences, highlighterColor: preset.color, highlighterSize: preset.size, layer: preset.layer }
      : { ...drawingPreferences, penColor: preset.color, penSize: preset.size, layer: preset.layer };
    persistDrawingPreferences(next);
  }

  function persistDrawingPreferences(next: DrawingPreferences) {
    setDrawingPreferences(next);
    if (connectionRef.current !== 'online') return setNotice('颜色已用于当前画布；连接恢复后请重新选择以保存色位。');
    drawingWritesPending.current++;
    drawingWriteQueue.current = drawingWriteQueue.current.catch(() => undefined).then(async () => {
      try { await api.setInteractionSettings({ drawingPreferences: next }); mutationEpoch.current++; }
      catch (error) { handleMutationError(error); }
      finally { drawingWritesPending.current--; }
    });
  }

  async function saveSettings(value: { keyBindings: ShortcutMap; drawingPreferences: DrawingPreferences }) {
    await drawingWriteQueue.current;
    await api.setInteractionSettings(value);
    mutationEpoch.current++;
    try { await reload(); }
    catch (error) {
      if (isConnectionError(error)) changeConnection('offline');
      setNotice('设置已保存，画布暂未刷新。恢复连接后将显示新设置。');
      return;
    }
    flashNotice('操控与绘制设置已保存。');
  }

  async function importSnapshot() {
    if (connectionRef.current !== 'online') return setNotice('恢复本地服务后再同步快照。');
    try {
      const result = await api.importSnapshot(snapshotText);
      flashNotice(`已同步 ${result.projectsSeen ?? 0} 个项目、${result.threadsSeen ?? 0} 条对话；同项目的对话合在一个气泡，已有布局保留。`);
      setMenu(current => current?.path.at(-1) === 'snapshot' ? { ...current, path: current.path.slice(0, -1) } : current); setSnapshotPreview(null); setSnapshotText(''); await reload();
    } catch (error) { handleMutationError(error); }
  }

  async function refreshSkins(reportFailure = false) {
    try {
      const result = await api.skins();
      setSkinItems(result.items);
      setSkinManifests(result.manifests);
    } catch (error) {
      if (reportFailure) handleMutationError(error);
    }
  }

  async function applySkin(key: string) {
    const manifest = skinManifests.find((item) => skinVersionKey(item) === key);
    if (!manifest) return setNotice('这个 Skin 当前不可用，已保留内置回退外观。');
    const components = Object.fromEntries(skinComponentIds(manifest).map((component) => [component, createSkinReference(manifest, component)]));
    try {
      await api.setSkin({ activeSkinRef: key, components });
      await reload();
      flashNotice(`已应用「${manifest.displayName}」。`);
    } catch (error) { handleMutationError(error); }
  }

  async function applySkinToSelected(key: string, component: 'taskBubble' | 'note') {
    if (!writable()) return;
    const current = boardRef.current;
    const node = current?.nodes.find((item) => item.id === selectedIdRef.current);
    const manifest = skinManifests.find((item) => skinVersionKey(item) === key);
    if (!node || !manifest) return;
    try {
      await api.updateNode(node.id, { skinRef: createSkinReference(manifest, component), revision: node.revision });
      await reload();
      flashNotice(`已只给选中项应用「${manifest.displayName}」。`);
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
  }

  async function applySkinComponent(key: string, component: SkinComponentId) {
    const manifest = skinManifests.find((item) => skinVersionKey(item) === key);
    const current = boardRef.current;
    if (!manifest || !current || !getSkinComponent(manifest, component)) return;
    try {
      await api.setSkin({ components: { ...current.settings.skinComponents, [component]: createSkinReference(manifest, component) } });
      await reload();
      flashNotice(`已把「${manifest.displayName}」的${({ background: '背景', chrome: '界面', taskBubble: '项目气泡', note: '便签', link: '连线', inkPalette: '墨迹色板' } as const)[component]}放进当前组合。`);
    } catch (error) { handleMutationError(error); }
  }

  async function clearSelectedSkin() {
    if (!writable()) return;
    const node = boardRef.current?.nodes.find((item) => item.id === selectedIdRef.current);
    if (!node) return;
    try { await api.updateNode(node.id, { skinRef: null, revision: node.revision }); await reload(); }
    catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
  }

  async function importSkin(text: string) {
    try {
      const result = await api.installSkin(text);
      await refreshSkins(true);
      flashNotice(`已安装「${result.displayName}」，尚未应用。`);
    } catch (error) { handleMutationError(error); }
  }

  async function addAnnotation(body: string) {
    if (!writable()) return;
    if (!selected || !body.trim()) return;
    if (!board?.nodes.some((node) => node.id === selected.id)) return setNotice('这是旧缓存中的项目占位；连接并更新看板后可批注。');
    if (connectionRef.current !== 'online') return setNotice('批注暂不进入离线队列；恢复连接后再添加。');
    try { await api.annotate(selected.id, body); await reload(); } catch (error) { handleMutationError(error); }
  }

  async function addLink(targetNodeId: string) {
    if (!writable()) return;
    const currentBoard = boardRef.current;
    const sourceCanvasId = selectedIdRef.current;
    if (!currentBoard || !sourceCanvasId || !targetNodeId || linkBusyRef.current) return;
    if (connectionRef.current !== 'online') return setNotice('恢复连接后再建立关联。');
    const records = visibleCanvasRecords(currentBoard);
    const sourceRecord = records.find((record) => record.id === sourceCanvasId);
    const targetRecord = records.find((record) => record.id === targetNodeId);
    if (!sourceRecord || !targetRecord) return setNotice('连接目标已不在当前画布，请重新选择。');
    const sourceEndpoint = persistedLinkEndpoint(currentBoard, sourceRecord);
    const targetEndpoint = persistedLinkEndpoint(currentBoard, targetRecord);
    if (!sourceEndpoint || !targetEndpoint) return setNotice('这是旧缓存中的只读占位；连接并更新看板后才能建立关联。');
    const alreadyVisible = canvasLinks(currentBoard, records).some((link) =>
      (link.sourceNodeId === sourceCanvasId && link.targetNodeId === targetNodeId) ||
      (link.sourceNodeId === targetNodeId && link.targetNodeId === sourceCanvasId));
    if (alreadyVisible || hasLinkBetween(currentBoard, sourceEndpoint, targetEndpoint)) return setNotice('这两个气泡已经连接。');
    const sourceNode = nodesRef.current.find((node) => node.id === sourceCanvasId);
    const targetNode = nodesRef.current.find((node) => node.id === targetNodeId);
    linkBusyRef.current = true;
    try {
      await api.link(sourceEndpoint, targetEndpoint);
      await reload();
      flashNotice(`已连接「${sourceNode ? bubbleLabel(sourceNode) : sourceRecord.title}」与「${targetNode ? bubbleLabel(targetNode) : targetRecord.title}」。`);
    } catch (error) { handleMutationError(error); }
    finally { linkBusyRef.current = false; }
  }

  async function askCurator() {
    if (connectionRef.current !== 'online') return setCuratorAnswer('看板顾问需要本地服务；当前仍可浏览缓存并记便签。');
    setCuratorAnswer('正在整理（只读）…');
    try {
      const result = await api.askCurator(curatorQuestion);
      setCuratorAnswer(result.kind === 'handoff' ? `${result.reason || ''}\n\n交接草稿：\n${result.draft || ''}` : String(result.answer || '没有返回文字。'));
    } catch (error) {
      if (isConnectionError(error)) changeConnection('offline');
      setCuratorAnswer(errorMessage(error));
    }
  }

  async function archiveNote(id: string) {
    if (!writable() || selectionBusyRef.current || historyBusyRef.current) return;
    if (connectionRef.current !== 'online' || id.startsWith('offline-note:')) return setNotice('便签仍安全保留；恢复连接并同步后再归档。');
    selectionBusyRef.current = true;
    try {
      if (!await finishCanvasEditors()) return;
      setCanvasBusy(true);
      if (!await noteSaver.finish(id)) { setNoteRecoveryOpen(true); return; }
      const current = boardRef.current?.nodes.find(node => node.id === id);
      if (!current || current.kind !== 'note' || current.archivedAt || pageId(current) !== currentPageRef.current || !writable()) return;
      await api.archiveNote(id, true, current.revision);
      mutationEpoch.current++;
      setEditingNoteId(editing => editing === id ? null : editing);
      await reload();
      flashNotice(`便签已归档。按 ${shortcuts.menu} 打开菜单，可在「页面 → 本页便签归档」找回。`);
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); }
    finally { selectionBusyRef.current = false; setCanvasBusy(false); }
  }

  async function restoreArchivedNote(note: CanvasNodeRecord) {
    if (!writable()) return;
    try {
      await api.archiveNote(note.id, false, note.revision);
      await reload();
      flashNotice('便签已恢复到原来的位置。');
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); throw error; }
  }

  async function deleteArchivedNote(note: CanvasNodeRecord) {
    if (!writable()) return;
    try {
      await api.deleteNote(note.id, note.revision);
      await reload();
      flashNotice('这张归档便签及其批注、关联已永久删除，无法从归档区恢复。');
    } catch (error) { handleMutationError(error); await reload().catch(() => undefined); throw error; }
  }

  async function pairCurator(threadId: string) {
    try { await api.pairCurator(threadId); await reload(); }
    catch (error) { handleMutationError(error); }
  }

  async function startBlankPage() {
    const current = boardRef.current;
    if (!current) return false;
    const id = currentPageRef.current;
    const occupied = current.nodes.some(node => pageId(node) === id) || current.inkStrokes.some(stroke => pageId(stroke) === id)
      || visibleCanvasRecords(current).some(record => pageId(record) === id)
      || nodesRef.current.some(node => node.data.isDraft && pageId(node.data.record) === id) || failedPaste.some(item => item.pageId === id);
    if (occupied || boardPages(current).find(page => page.id === id)?.archivedAt) {
      if (connectionRef.current !== 'online' || !await createPage('空白页')) return false;
    }
    setProjectKey('all'); setLens('all'); setMenu(null); setInkTool('select');
    applySelection([]); setSelectedInkIds([]);
    return true;
  }

  function openSavedProjects() { openSection('projects'); }

  function handleMutationError(error: unknown) {
    if (isConnectionError(error)) changeConnection('offline');
    showError(error);
  }

  function showError(error: unknown) { setNotice(errorMessage(error)); }

  // Keep the static loading surface until the board or a confirmed recovery action is available.
  if (!board && !startupError) return null;
  if (!board) return <main className="loading-screen">
    <h1>暂时无法打开看板</h1>
    <p>请重新连接本地服务。桌面版也可以从系统托盘选择「重启本地服务」。</p>
    <button className="primary" onClick={() => { setStartupError(''); changeConnection('checking'); void bootstrap(); }}>重新连接</button>
    <details><summary>故障详情</summary><p>{startupError}</p></details>
    <button onClick={() => openMenuDetail('feedback', 'data')}>反馈与帮助</button>
    {detail === 'feedback' && <FeedbackPanel onClose={closeBoardMenu} onBack={menu?.path.at(-2) === 'guide' ? backInMenu : undefined} backLabel="使用指南" />}
    <button onClick={() => openMenuDetail('guide', 'data')}>使用指南与 Agent 定制</button>
    {detail === 'guide' && <OnboardingPanel canUseBoard={false} online={false} access={null} onClose={closeBoardMenu}
      onCreateNote={() => {}} onTryInk={() => {}} onFitView={() => {}} onOpenSettings={() => {}} onOpenSkins={() => {}} onOpenFeedback={() => openMenuDetail('feedback', 'data')} />}
  </main>;
  const singleNote = selected?.kind === 'note' && selectedIds.length === 1 && !selectedInkIds.length;
  const moveControls = <><select aria-label="移动到页面" value={moveTarget} onChange={event => setMoveTarget(event.target.value)}><option value="">移动到页面…</option>{pages.filter(page => !page.archivedAt && page.id !== currentPageId).map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select>
    <button disabled={!moveTarget || connection !== 'online'} onClick={() => void moveSelectionToPage(moveTarget)}>移动选区</button></>;
  const selectionDetails = (close: () => void) => selected && <DetailPanel key={selected.id} boardRevision={board.boardRevision} node={selected} thread={selectedThread} project={selectedProject} threadToLocate={threadToLocate} onBoardChange={reload} nodes={globalCanvasRecords} links={globalMappedLinks} pages={pages} readOnly={readOnly} onLocate={record => { void locateRecord(record); }} archivedRelations={selectedArchiveRelations} annotations={annotations} online={!readOnly && connection === 'online' && board.nodes.some((node) => node.id === selected.id)} onClose={close}
    canReadSource={Boolean(codexAccess?.localRead && !readOnly && connection === 'online')}
    canSummarize={Boolean(codexAccess?.modelUse)} onOpenPermissions={() => {
      projectMenuTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setMenu({ section: 'projects', path: ['permissions'], fromProject: true });
    }}
    projectNotes={selectedProject ? onShowAll => <ProjectNotes board={board} projectKey={selectedProject.project.projectKey} priorityDate={priorityDate}
      onShowAll={onShowAll} onLocate={record => void locateRecord(record)} /> : undefined}
    noteActions={singleNote && <><NoteChecklist note={noteSaver.overlay(selected)} disabled={readOnly}
      onChange={content => editNote(selected.id, content.body, content.noteDocument)} /><NoteOriginLink note={selected} board={board} onLocate={focusThread} /><div className="note-detail-actions">
      {!readOnly && pages.some(page => !page.archivedAt && page.id !== currentPageId) && moveControls}
      {selected.notePresentation !== 'image' && <button type="button" onClick={() => void copyCurrentNoteText(noteSaver.overlay(selected)).then(() => flashNotice('已复制便签原文。')).catch(showError)}>复制原文</button>}
      <button type="button" onClick={() => {
        const surface = stageRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(selected.id)}"] .bubble-surface`);
        if (surface) void copyNoteImage(surface, noteSaver.overlay(selected)).catch(showError);
      }}>保存并复制便签图片</button>
      {!readOnly && visibleNodes.find(node => node.id === selected.id)?.data.onFold && <button type="button" onClick={visibleNodes.find(node => node.id === selected.id)?.data.onFold}>收进上游</button>}
    </div></>}
    suppressConversation={drawerOpen || exportOpen || noteRecoveryOpen}
    foldedNotes={folding.hosted.get(selected.id) || []} onUnfold={(id) => void changeFold(id, null)} onNotice={setNotice}
    editStatus={noteSaver.entries.get(selected.id)} onRetrySave={() => void noteSaver.flush(selected.id)} onResolveConflict={resolveNoteConflict}
    onSelectLink={(id) => selectEdge(id, true)} selectedLinkId={selectedEdgeId} onDeleteLink={deleteLink}
    onAnnotate={addAnnotation} onLink={addLink} onArchive={() => archiveNote(selected.id)} onOpenArchivedNote={async (noteId) => {
      if (!await finishCanvasEditors()) return;
      setArchiveFocusId(noteId); applySelection([]); openMenuDetail('archive', 'pages');
    }} />;
  const online = connection === 'online';
  const previousDetail = menu?.path.at(-2);
  const navigation = { onBack: backInMenu, onClose: closeBoardMenu,
    backLabel: previousDetail ? menuDetails[previousDetail] : menu?.fromProject ? '项目详情' : menu ? menuSections[menu.section] : undefined };
  function openSkins() { openMenuDetail('skins', 'appearance'); void refreshSkins(true); }
  const nextTheme = board.settings.activeSkinRef?.startsWith('archive-paper@') ? DEFAULT_SKIN_KEY : DEFAULT_LIGHT_SKIN_KEY;
  const menuSectionContent = menu?.section === 'pages' ? <>
    <PageNavigation pages={pages} currentId={currentPageId} defaultId={board.settings.defaultPageId || DEFAULT_PAGE_ID} online={online} backgrounds={skinManifests}
      onSwitch={id => { void switchPage(id).then(ok => { if (ok) closeBoardMenu(); }); }} onCreate={name => { void createPage(name); }}
      onRename={(page, name) => { void patchPage(page, { name }); }} onArchive={(page, archived) => { void changePageArchive(page, archived); }}
      onDefault={id => { void mutatePage(() => api.setDefaultPage(id)); }} onDelete={page => { void deleteEmptyPage(page); }}
      onReorder={ids => { void mutatePage(() => api.orderPages(ids)); }} onBackground={(page, backgroundSkinRef) => { void patchPage(page, { backgroundSkinRef }); }}
      onOpenWallpaper={() => openMenuDetail('wallpaper', 'pages')}
      onContinue={page => { void patchPage(page, { autoCheckPaused: false }); }} />
    <button className="menu-link" onClick={() => { setArchiveFocusId(null); openMenuDetail('archive', 'pages'); }}>本页便签归档 <small>{archive.length}</small></button>
  </> : menu?.section === 'appearance' ? <>
    <button className="menu-link" onClick={openSkins}>皮肤库</button>
    <button className="menu-link" disabled={!online} onClick={() => void applySkin(nextTheme)}>{nextTheme === DEFAULT_SKIN_KEY ? '改用深色「夜墨」皮肤' : '改用浅色「静纸」皮肤'}</button>
    <button className="menu-link" onClick={() => openMenuDetail('wallpaper', 'appearance')}>背景图片</button>
    <details className="menu-fold"><summary>优先级图案</summary><PriorityIconSettings current={board.settings.priorityIcons ?? defaultPriorityIcons} online={online}
      onSaved={async () => { mutationEpoch.current++; await reload(); }} /></details>
  </> : menu?.section === 'controls' ? <>
    <section className="drawer-section"><h3>画布筛选</h3>
      <div className="drawer-lenses" role="group" aria-label="画布筛选">
        {([['all','全景'],['priority','我的优先'],['uncertain','待厘清'],['notes','便签']] as [Lens,string][]).map(([value,label]) =>
          <button key={value} aria-pressed={lens === value} className={lens === value ? 'active' : ''} onClick={() => { if (value === 'notes' || value === 'priority') setProjectKey('all'); setLens(value); closeBoardMenu(); }}>{label}</button>)}
      </div>
      <div className="canvas-zoom" role="group" aria-label="画布缩放">
        <button aria-label="缩小画布" onClick={() => void zoomOut()}>−</button><output>{Math.round(canvasViewport.zoom * 100)}%</output>
        <button aria-label="放大画布" onClick={() => void zoomIn()}>+</button>
      </div>
      <button className="menu-link" onClick={() => { setProjectKey('all'); setLens('all'); closeBoardMenu(); requestAnimationFrame(() => void fitView({ padding: .24, duration: 350, maxZoom: 1 })); }}>清除筛选并看全画布</button>
    </section>
    <div className="history-row">
      <button disabled={!board.historyStatus.canUndo || !online} onClick={() => void runHistory('undo')}>撤销{board.historyStatus.undoLabel && ` · ${board.historyStatus.undoLabel}`}</button>
      <button disabled={!board.historyStatus.canRedo || !online} onClick={() => void runHistory('redo')}>重做{board.historyStatus.redoLabel && ` · ${board.historyStatus.redoLabel}`}</button>
    </div>
    <ControlSettings shortcuts={shortcuts} drawing={drawingPreferences} draft={settingsDraft} onDraftChange={setSettingsDraft} online={online}
      onSave={saveSettings} onSaveError={setNotice} highlighterOpacity={activeInkPalette && 'highlighterOpacity' in activeInkPalette ? activeInkPalette.highlighterOpacity : undefined} />
  </> : menu?.section === 'data' ? <>
    <button className="menu-link" onClick={() => openMenuDetail('guide', 'data')}>使用指南</button>
    <button className="menu-link" onClick={() => openMenuDetail('feedback', 'data')}>反馈与帮助</button>
    <DataSettings online={online} serviceHealth={serviceHealth} />
  </> : null;
  const renderMenuDetail = (page: MenuDetail) => {
    switch (page) {
      case 'responses': return <PortfolioPanel board={board} records={globalCanvasRecords} {...navigation} onFocusThread={key => focusThread(key, true)} />;
      case 'updates': return <MenuPage title="项目更新" {...navigation}>
        <SummarySyncPanel online={online} codexAccess={codexAccess} onOpenOnboarding={() => openMenuDetail('permissions', 'projects')} />
        <details className="menu-fold"><summary>其他操作</summary>
          <button className="menu-link" disabled={!online} onClick={() => openMenuDetail('snapshot', 'projects')}>导入快照</button>
          <button className="menu-link" disabled={!online} onClick={() => openMenuDetail('curator', 'projects')}>看板顾问</button>
        </details>
      </MenuPage>;
      case 'wallpaper': return <MenuPage title="背景图片" {...navigation}>
        <WallpaperSettings global={board.settings.wallpaper ?? null} page={currentPage} presets={board.settings.wallpaperPresets} online={online}
          initialScope={menu?.section === 'pages' ? 'page' : 'board'} leaveGuard={menuLeaveGuard} onSaved={async () => { mutationEpoch.current++; await reload(); }} />
      </MenuPage>;
      case 'skins': return <SkinPanel {...navigation} items={skinItems} manifests={skinManifests} activeKey={board.settings.activeSkinRef || DEFAULT_SKIN_KEY}
        activeComponents={board.settings.skinComponents} selectedNodeKind={selected?.kind} online={online} onApplySkin={applySkin} onApplyComponent={applySkinComponent}
        onApplyToSelected={applySkinToSelected} onClearSelected={clearSelectedSkin} onImport={importSkin} />;
      case 'archive': return <ArchivePanel {...navigation} relations={archiveRelations} focusedNoteId={archiveFocusId} online={online} readOnly={readOnly} onRestore={restoreArchivedNote} onDelete={deleteArchivedNote} />;
      case 'feedback': return <FeedbackPanel {...navigation} />;
      case 'permissions':
      case 'guide': return <OnboardingPanel key={page} initialTab={page === 'permissions' ? 'codex' : 'quick'} {...navigation} online={online} access={codexAccess}
        hasSavedProjects={board.projects.length > 0} onOpenProjects={openSavedProjects} onStartBlankPage={startBlankPage}
        onCreateNote={() => { void startDraftNote(); }} onTryInk={() => { applySelection([]); setSelectedInkIds([]); setInkTool('pen'); }}
        onFitView={() => { setProjectKey('all'); setLens('all'); void fitView({ padding: .24, duration: 350, maxZoom: 1 }); }}
        onOpenSettings={() => openMenuDetail('updates', 'projects')} onOpenSkins={openSkins} onOpenFeedback={() => openMenuDetail('feedback', 'data')} />;
      case 'snapshot': return <MenuPage title="导入快照" {...navigation}>
        <p>请 Codex 按仓库内的 <code>review-project-progress</code> Skill 导出 ZZ Board 快照 JSON，把返回的完整代码块粘贴到这里。预览后再确认导入。</p>
        <textarea className="snapshot-input" value={snapshotText} onChange={(event) => { setSnapshotText(event.target.value); setSnapshotPreview(null); }} placeholder="```zz-board-snapshot\n{ ... }\n```" />
        {snapshotPreview && <pre className="preview-box">{JSON.stringify(snapshotPreview, null, 2)}</pre>}
        <div className="modal-actions"><button onClick={() => api.previewSnapshot(snapshotText).then(setSnapshotPreview).catch(handleMutationError)}>先预览</button><button className="primary" disabled={!snapshotPreview} onClick={importSnapshot}>确认导入</button></div>
      </MenuPage>;
      case 'curator': return <MenuPage title="看板顾问" {...navigation}>
        {!board.settings.curatorThreadId && <PairCurator onPair={pairCurator} />}
        <p>它只读取当前快照并给建议；需要继续项目任务时，只生成一份交接草稿，由你决定是否发送。</p>
        <textarea value={curatorQuestion} onChange={(event) => setCuratorQuestion(event.target.value)} />
        <button className="primary" disabled={!board.settings.curatorThreadId} onClick={askCurator}>问一问</button>
        {curatorAnswer && <pre className="preview-box">{curatorAnswer}</pre>}
      </MenuPage>;
    }
  };
  return (
    <main className={`app-shell zen-shell${exportOpen ? ' is-exporting' : ''}`} inert={canvasBusy} aria-busy={canvasBusy}>
      <button ref={menuHandle} className="zen-handle" aria-label="打开项目菜单" aria-expanded={drawerOpen} aria-controls={drawerOpen ? 'board-menu' : undefined}
        hidden={drawerOpen || noteRecoveryOpen || Boolean(notePanel || focusedNote)} onClick={() => openSection('projects')} title="项目菜单">
        <span className={`privacy-dot ${connection !== 'online' ? 'is-offline' : ''}`} />
      </button>
      {menu && <BoardMenu board={board} pages={pages} records={globalCanvasRecords} currentPage={currentPage?.name || 'page 1'}
        location={menu} onSection={openSection} sectionContent={menuSectionContent} detailContent={detail && renderMenuDetail(detail)}
        onFocusThread={key => focusThread(key, true)} canWrite={!readOnly && connection !== 'incompatible'} menuKey={shortcuts.menu} noteKey={shortcuts.newNote}
        onClose={closeBoardMenu} onWrite={() => { void startDraftNote(); }} onLocate={record => { void locateRecord(record, undefined, true); }}
        onResponses={async () => { if (await finishCanvasEditors()) openMenuDetail('responses', 'projects'); }}
        onUpdates={() => openMenuDetail('updates', 'projects')}
        status={(connection !== 'online' || queuedCount > 0) && <span role="status">{connection === 'incompatible' ? '版本待刷新' : connection !== 'online' ? '离线浏览' : ''}{queuedCount ? ` ${queuedCount} 张便签待同步` : ''}</span>} />}
      <section ref={stageRef} inert={drawerOpen} className={`board-stage ${broadScale ? 'is-broad-scale' : ''} ${marquee ? 'is-marquee-selecting' : ''} ${touchNavigating ? 'is-touch-navigating' : ''} ${viewportNavigating ? 'is-viewport-navigating' : ''}`}
        style={{
          '--priority-scale': 1 / canvasViewport.zoom,
          '--notice-left': drawerOpen ? 'min(392px, 98vw)' : '0px',
          '--notice-right': !drawerOpen && selected?.kind === 'task' && !navigationOnly ? (selectedProject ? '490px' : '390px') : '0px'
        } as CSSProperties}
        onFocusCapture={event => {
          if (exportOpen || focusedNote || !event.target.matches('.react-flow__node')) { clearHoverPreview(); return; }
          const record = canvasRecordMap.get(event.target.dataset.id || '');
          if (!record) return;
          clearHoverPreview();
          const rect = event.target.getBoundingClientRect();
          hoverNodeRef.current = record.id;
          setHoveredLinkNodeId(record.id);
          setHoverPreview({ nodeId: record.id, ...previewPoint(rect.right, rect.top + rect.height / 2) });
        }}
        onBlurCapture={event => { if (event.target.matches('.react-flow__node')) clearHoverPreview(); }}
        onPointerOverCapture={event => { if (hoverNodeRef.current && isBubbleControl(event.target)) clearHoverPreview(); }}
        onPointerDownCapture={exportOpen ? undefined : beginMarquee} onPointerMove={event => { lastCanvasPointer.current = { x: event.clientX, y: event.clientY }; moveMarquee(event); }} onPointerLeave={() => { lastCanvasPointer.current = null; }} onPointerUp={finishMarquee} onPointerCancel={(event) => { cancelMarquee(event); cancelSelectionMove(); }}
        onContextMenu={(event) => { if (event.target instanceof Element && event.target.closest('.react-flow__pane')) event.preventDefault(); }}>
        {wallpaper && <div className="board-wallpaper" aria-hidden="true"><WallpaperScene value={wallpaper} /></div>}
        {connection === 'offline' && <section className="connection-banner" role="status">
          <div><strong>离线也能继续</strong><span>正在显示{cachedAt ? ` ${formatAge(cachedAt)}保存的` : '缓存的'}看板；新便签会排队，其他编辑暂缓。</span></div>
          <button onClick={() => void recoverConnection()}>立即重连</button>
        </section>}
        {versionMismatch && <section className="version-banner" role="status">
          <span>界面 {APP_VERSION} 与本地服务 {versionMismatch} 版本不一致，写入已暂停。请刷新；仍有提示时，从托盘退出旧版并打开配套程序。</span>
          <button onClick={() => window.location.reload()}>刷新页面</button>
        </section>}
        {notice && <button key={noticeKey} className={transient ? "notice notice-transient" : "notice"} onClick={() => setNotice('')}>{notice}<span>×</span></button>}
        {filteredNoteCount > 0 && <div className="canvas-filter-hint" role="status"><span>{filteredNoteCount} 张便签被当前视图隐藏，未删除</span><button onClick={() => { setProjectKey('all'); setLens('notes'); }}>显示便签</button></div>}
        <ImageExportFeedback hasNotice={!!notice} onShow={() => setNotice('')} />
        <div className="page-status" role="status">{currentPage?.name || 'page 1'}{readOnly ? ' · 归档只读' : currentPage?.autoCheckPaused ? ' · 自动检查暂停' : ''}
          {readOnly && currentPage && <button disabled={connection !== 'online'} onClick={() => void changePageArchive(currentPage, false)}>恢复页面</button>}
        </div>
        {!readOnly && failedPaste.length > 0 && <button className="image-paste-retry" onClick={() => void pasteCards(failedPaste)}>重试添加 {failedPaste.length} 张图片（仍回原页）</button>}
        {!readOnly && !singleNote && (selectedIds.length > 0 || selectedInkIds.length > 0) && <div className="page-selection-actions" onPointerDown={event => event.stopPropagation()}>
          {selectedIds.length > 0 && <select aria-label="设置选中项的手动优先级" value="" disabled={connection !== 'online'}
            onChange={event => { const level = event.target.value; if (level === 'p1' || level === 'p2' || level === 'clear') void setSelectedPriority(level === 'clear' ? null : level); }}>
            <option value="">手动优先级…</option><option value="p2">关注</option><option value="p1">优先</option><option value="clear">清除手动标记</option>
          </select>}
          {moveControls}
        </div>}
        <ReactFlow
          nodes={visibleNodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange}
          onEdgeClick={(event, edge) => { event.stopPropagation(); if (inkTool === 'select' && !spacePan) selectEdge(edge.id); }}
          onNodeClick={onNodeClick} onNodeContextMenu={onNodeContextMenu} onNodeMouseEnter={onNodeMouseEnter} onNodeMouseMove={onNodeMouseMove} onNodeMouseLeave={onNodeMouseLeave} onPaneClick={async event => {
            if (inkTool !== 'select' || spacePan || exportOpen) return;
            if (event.detail === 2) startDraftNote(screenToFlowPosition({ x: event.clientX, y: event.clientY }));
            else if (await finishCanvasEditors()) { if (editingNoteId) finishNote(editingNoteId); applySelection([]); setSelectedInkIds([]); }
          }} onNodeDragStop={onNodeDragStop}
          onNodeDragStart={(_event, node) => {
            const included = selectedIdsRef.current.includes(node.id);
            if (!included) { applySelection([node.id]); setSelectedInkIds([]); }
            nodeDragModeRef.current = connectionRef.current === 'offline' && node.id.startsWith('offline-note:') ? 'offline'
              : beginSelectionMove(included ? selectedIdsRef.current : [node.id], included ? selectedInkIds : []) ? 'online' : 'blocked';
          }}
          onNodeDrag={(_event, node) => {
            const origin = selectionMoveRef.current?.nodes.find((item) => item.id === node.id);
            if (origin) setSelectionDelta({ x: node.position.x - origin.x, y: node.position.y - origin.y });
          }}
          defaultViewport={currentPage?.viewport || board.viewport} minZoom={0.2} maxZoom={2.2} nodesConnectable={false} deleteKeyCode={null}
          onInit={flow => { const viewport = flow.getViewport(); trackScale(viewport); setCanvasViewport(viewport); }}
          nodesDraggable={!readOnly && !exportOpen && inkTool === 'select' && !spacePan} elementsSelectable={!exportOpen && inkTool === 'select' && !spacePan}
          autoPanOnNodeDrag={!touchNavigating}
          multiSelectionKeyCode={null} selectionKeyCode={null} panActivationKeyCode={null} panOnDrag={spacePan || !exportOpen && inkTool === 'select' ? [0] : false}
          zoomOnDoubleClick={false}
          onMoveStart={() => setViewportNavigating(true)}
          onMove={(_event, viewport: Viewport) => { trackScale(viewport); setCanvasViewport(viewport); }}
          onMoveEnd={(_event, viewport: Viewport) => {
            setViewportNavigating(false);
            if (touchViewportRef.current?.isActive() || touchViewportRef.current?.isConsumed(_event)) return;
            trackScale(viewport);
            queueViewportSave(viewport);
          }}
          fitViewOptions={{ padding: 0.24 }} proOptions={{ hideAttribution: true }}
        >
          {!wallpaper && <Background variant={BackgroundVariant.Dots} gap={34} size={1} color="var(--grid-dot)" />}
          <InkCanvas
            strokes={displayedInk}
            tool={readOnly ? 'select' : inkTool}
            preset={inkPreset}
            zoom={canvasViewport.zoom}
            viewportBounds={viewportBounds}
            selectedInkIds={selectedInkIds}
            externalSelectionOverlay
            eraserMode={drawingPreferences.eraserMode}
            lassoMode={(drawingPreferences.lassoMode === 'all' ? 'includeObjects' : 'inkOnly') as InkLassoMode}
            panActive={spacePan || exportOpen}
            objectBounds={visibleNodes.filter((node) => !node.hidden).map((node) => ({ id: node.id, bounds: {
              x: node.position.x, y: node.position.y,
              width: Number(node.width || node.data.record.width), height: Number(node.height || node.data.record.height)
            } }))}
            screenToWorld={screenToFlowPosition}
            onCreateStroke={createInkStroke}
            onErase={eraseInk}
            onSelectInk={selectInk}
            onLassoComplete={() => { setInkTool('select'); setSelectionAsGroup(true); }}
            onMoveStart={(ids) => beginSelectionMove(selectedIdsRef.current, ids)}
            onMovePreview={(delta) => { if (selectionMoveRef.current) setSelectionDelta(delta); }}
            onMoveEnd={(delta) => void finishSelectionMove(delta)}
            onMoveCancel={cancelSelectionMove}
            onSelectObjects={(ids, mode) => applySelection(mode === 'add' ? [...selectedIdsRef.current, ...ids] : ids, ids.at(-1) || null)}
            onTransformSelected={transformInk}
            onStyleSelected={styleInk}
            onDeleteSelected={(ids) => void deleteSelection(ids)}
          />
          {!readOnly && !exportOpen && groupBounds && inkTool === 'select' && !spacePan && (selectionAsGroup || selectedIds.length + selectedInkIds.length > 1 || selectedInkIds.length > 0) && <SelectionOverlay
            bounds={groupBounds} zoom={canvasViewport.zoom} count={selectedIds.length + selectedInkIds.length} toWorld={screenToFlowPosition}
            scaleFactor={selectionScale?.factor} onBeginScale={beginSelectionScale} onScalePreview={setSelectionScale} onScaleEnd={transform => void finishSelectionScale(transform)}
            onBegin={() => beginSelectionMove()} onPreview={setSelectionDelta} onEnd={(delta) => void finishSelectionMove(delta)} onCancel={cancelSelectionMove} onDelete={() => void deleteSelection()} />}
          <MiniMap pannable zoomable ariaLabel="当前页缩略图" style={{width:144, height:90}} nodeColor={(node) => (node.data as BubbleData).record.kind === 'note' ? 'var(--note)' : 'var(--accent)'} maskColor="var(--minimap-mask)" />
        </ReactFlow>
        {exportOpen && <ExportRegion nodes={visibleNodes} edges={edges} strokes={displayedInk} viewport={canvasViewport} panActive={spacePan} toWorld={screenToFlowPosition} onViewport={view => { void setViewport(view); }} onClose={() => setExportOpen(false)} onNotice={setNotice} />}
        {!readOnly && <ToolPalette tool={inkTool} preset={inkPreset} eraserMode={drawingPreferences.eraserMode} exportActive={exportOpen} onExport={() => { setMenu(null); setExportOpen(!exportOpen); }}
          lassoMode={drawingPreferences.lassoMode === 'all' ? 'includeObjects' : 'inkOnly'}
          shortcuts={{ select: shortcuts.selectTool, pen: shortcuts.penTool, highlighter: shortcuts.highlighterTool, eraser: shortcuts.eraserTool, lasso: shortcuts.lassoTool }}
          colorSlots={drawingPreferences.highlighterColorSlots}
          skinPalette={activeInkManifest?.schemaVersion === 3 && activeInkPalette && 'colors' in activeInkPalette ? activeInkPalette : undefined}
          onColorSlotsChange={(highlighterColorSlots, selectedColor) => {
            const next = { ...drawingPreferences, highlighterColorSlots, highlighterColor: selectedColor || drawingPreferences.highlighterColor };
            persistDrawingPreferences(next);
          }}
          onToolChange={(tool) => { setInkTool(tool); if (tool !== 'select') { applySelection([]); setSelectedInkIds([]); } }}
          onPresetChange={updateInkPreset}
          onEraserModeChange={(eraserMode) => {
            persistDrawingPreferences({ ...drawingPreferences, eraserMode });
          }}
          onLassoModeChange={(lassoMode) => {
            persistDrawingPreferences({ ...drawingPreferences, lassoMode: lassoMode === 'includeObjects' ? 'all' : 'ink' });
          }} />}
        {marquee && <div className="marquee-selection" aria-hidden="true" style={{
          left: marquee.left - (stageRef.current?.getBoundingClientRect().left || 0),
          top: marquee.top - (stageRef.current?.getBoundingClientRect().top || 0),
          width: marquee.right - marquee.left,
          height: marquee.bottom - marquee.top
        }} />}
        {selectedIds.length > 1 && <div className="multi-selection-count" role="status">已选 {selectedIds.length} 项</div>}
        {selectedIds.length === 1 && <div className="link-source-hint" role="status">右键另一个气泡建立连线</div>}
        {hoverPreview && hoveredNode && <BubbleHoverPreview data={hoveredNode.data} x={hoverPreview.x} y={hoverPreview.y} />}
        {canvasRecords.length === 0 && displayedInk.length === 0 && !nodes.some((node) => node.data.isDraft && pageId(node.data.record) === currentPageId) && <div className="empty-canvas" role="status" aria-label="页面状态"><span>{readOnly ? '这张归档页没有画布内容' : '本页还没有内容'}</span><p>{readOnly ? '页面保持只读；恢复后可以添加内容。' : `按 ${shortcuts.newNote} 或双击空白写一张便签，也可以粘贴图片。新项目进入指定接收页。`}</p>{!readOnly && <button onClick={() => { void startDraftNote(); }}>新建便签</button>}{archive.length > 0 && <button onClick={() => { setArchiveFocusId(null); openMenuDetail('archive', 'pages'); }}>查看 {archive.length} 张归档便签</button>}</div>}
        {canvasRecords.length > 0 && visibleNodes.every(node => node.hidden) && displayedInk.length === 0 && <div className="empty-canvas" role="status"><span>当前筛选没有可见内容</span><p>本页内容仍在，可返回全景查看。</p><button onClick={() => { setProjectKey('all'); setLens('all'); }}>返回全景</button></div>}
      </section>

      <ImageViewer />
      {selected?.kind === 'task' && !navigationOnly && selectionDetails(() => applySelection([]))}
      {singleNote && !focusedNote && notePanel === 'details' && selectionDetails(() => setNotePanel(null))}
      {singleNote && !focusedNote && notePanel === 'schedule' && <aside className="detail-panel panel-shell" aria-label="便签安排">
        <header className="panel-fixed-header"><h2>安排</h2><button type="button" className="panel-close" aria-label="关闭安排" disabled={scheduleBusy} onClick={() => setNotePanel(null)}>×</button></header>
        <NoteScheduleForm key={selected.id} note={selected} today={priorityDate} disabled={readOnly || connection !== 'online'}
          onSave={saveNoteArrangement} onBusy={setScheduleBusy} onClose={() => { if (selectedIdRef.current === selected.id) setNotePanel(null); }} />
      </aside>}
      {focusedNote && noteFocusAnchor && <FocusedNote key={focusedNote.id} note={focusedNote} anchor={noteFocusAnchor} dataStoreId={serviceHealth?.dataStoreId}
        skinStyle={visibleNodes.find(node => node.id === focusedNote.id)?.data.skinStyle}
        priorityIcons={board.settings.priorityIcons} details={selectionDetails}
        priorityDate={priorityDate} onSaveArrangement={saveNoteArrangement} online={connection === 'online'} readOnly={readOnly} covered={noteRecoveryOpen} edit={noteSaver.entries.get(focusedNote.id)}
        onChange={(text, doc) => editNote(focusedNote.id, text, doc)} onComposition={active => noteSaver.composition(focusedNote.id, active)}
        onSave={() => void noteSaver.flush(focusedNote.id)} onClose={async () => {
          if (!readOnly) {
            await noteSaver.durable();
            finishNote(focusedNote.id);
          }
          setNoteFocusAnchor(current => current === noteFocusAnchor ? null : current);
        }} />}
      {noteRecoveryOpen && <Modal title="处理未保存的便签" onClose={() => setNoteRecoveryOpen(false)}>
        <NoteRecoveryList entries={[...noteSaver.entries.values()]} composing={(id) => noteSaver.isComposing(id)}
          onLocate={(id) => { const record = boardRef.current?.nodes.find(node => node.id === id) || noteSaver.entries.get(id)?.record; if (record) { setNoteRecoveryOpen(false); void locateRecord(record); } }}
          onRetry={(id) => { void reload().then(() => noteSaver.flush(id)).catch(handleMutationError); }} onResolve={resolveNoteConflict}
          onDiscard={(id) => { if (window.confirm('只放弃这份未保存的本机草稿，不删除服务端便签。请先复制需要保留的文字。确定放弃？')) noteSaver.discard(id); }} />
      </Modal>}
    </main>
  );
}

function PortfolioPanel({ board, records, onFocusThread, ...navigation }: MenuNavigation & {
  board: BoardState;
  records: CanvasNodeRecord[];
  onFocusThread(threadKey: string): void;
}) {
  const [tab, setTab] = useState<'responses' | 'todos' | 'stops'>('responses');
  const projectOrder = new Map(board.projects.map((project, index) => [project.projectKey, project.sidebarIndex ?? index]));
  const projects = [...board.projects]
    .sort((a, b) => (projectOrder.get(a.projectKey) ?? Number.MAX_SAFE_INTEGER) - (projectOrder.get(b.projectKey) ?? Number.MAX_SAFE_INTEGER));
  const priorities = projectPriorityMap(board, records);
  const actions = portfolioActions(board, records);
  const listed = tab === 'responses' ? actions.filter(({ action }) => awaitsResponse(action)) : actions;
  const projectNames = new Map(board.projects.map((project) => [project.projectKey, project.name]));

  return <section className="menu-page panel-shell summary-panel" aria-label="待我处理">
    <MenuHeader title="待我处理" {...navigation}>
      <nav className="panel-tabs" aria-label="项目记录分类"><button aria-current={tab === 'responses'} onClick={() => setTab('responses')}>待我处理</button><button aria-current={tab === 'todos'} onClick={() => setTab('todos')}>已记录事项</button><button aria-current={tab === 'stops'} onClick={() => setTab('stops')}>工作记录</button></nav>
    </MenuHeader>
    <div className="panel-scroll">

    {tab !== 'stops' && <section className="todo-list"><h3>{tab === 'responses' ? '已明确交给我的事项' : '已记录事项'} · {listed.length}</h3>
      {listed.length ? listed.map(({projectKey:key,action}) => {
        const {todo,sources} = action, thread = sources[0], recordedAt = actionRecordTime(action);
        return <article className="todo-card" key={todo ? `todo:${todo.todoKey}` : `thread:${thread!.threadKey}`}>
          <div className="todo-meta">{priorities.has(key) && <span data-priority={priorities.get(key)}>{manualPriorityLabel(priorities.get(key))}</span>}<span>{action.strength === 'recommended' || action.strength === 'optional' ? '对话建议' : actionLabel(action.kind)}</span></div>
          <small>{projectNames.get(key)}{historicalAction(action) && ' · 上次记录，待核对'}{recordedAt && ' · ' + new Date(recordedAt).toLocaleDateString('zh-CN')}</small>
          <h4>{action.text}</h4>
          {(todo?.evidence || thread?.recap?.summary.stopPoint || thread?.evidence) && <details><summary>查看依据</summary><p className="evidence-copy">{todo?.evidence || thread?.recap?.summary.stopPoint || thread?.evidence}</p></details>}
          {sources.length > 0 && <small>来源对话：<SourceThreadTitles threads={sources} onLocate={onFocusThread} /></small>}
        </article>;
      }) : <p className="empty-summary">{tab === 'responses' ? '已保存的对话中，没有已确认需要你处理的事项。' : '尚无已记录的事项。'}</p>}
    </section>}

    {tab === 'stops' && <section className="project-brief-list"><h3>工作记录 · {projects.length}</h3>
      {projects.map((project) => {
        const brief = board.projectBriefs.find((item) => item.projectKey === project.projectKey && !item.missingSince);
        const lines = projectReading({threads:board.threads.filter(thread => thread.projectKey === project.projectKey), brief});
        return <article className="brief-card" key={project.projectKey}>
          <header><b>{project.name}</b></header>
          {lines.length ? lines.map(line => <div key={line.thread?.threadKey ?? project.projectKey}>
            {line.text !== line.thread?.title && <p>{line.text}</p>}
            <small>{[readingQualifier(line), readingDate(line)].filter(Boolean).join(' · ')}</small>
            {line.thread && <SourceThreadTitles threads={[line.thread]} onLocate={onFocusThread} />}
          </div>) : <small>尚无已保存的工作记录。</small>}
        </article>;
      })}
    </section>}
    </div>
  </section>;
}

const projectSecondaryTabs = [['timeline', '历程'], ['annotations', '批注'], ['links', '关联']] as const;

function DetailPanel({ node, thread, project, boardRevision, threadToLocate, onBoardChange, nodes, links, pages, readOnly, onLocate, archivedRelations, annotations, online, onClose, onAnnotate, onLink, onArchive, onOpenArchivedNote, editStatus, onRetrySave, onResolveConflict, onSelectLink, onDeleteLink, selectedLinkId, foldedNotes, onUnfold, onNotice, suppressConversation, noteActions, projectNotes, canReadSource, canSummarize, onOpenPermissions }: {
  noteActions?: React.ReactNode; projectNotes?: (onShowAll?: () => void) => React.ReactNode;
  canReadSource: boolean; canSummarize: boolean; onOpenPermissions(): void;
  pages: CanvasPageRecord[]; readOnly: boolean; onLocate(record: CanvasNodeRecord): void;
  suppressConversation: boolean;
  boardRevision: number;
  onNotice(text: string): void;
  foldedNotes: CanvasNodeRecord[]; onUnfold(id: string): void;
  node: CanvasNodeRecord; thread?: BoardThread; nodes: CanvasNodeRecord[]; links: BoardState['links']; annotations: BoardState['annotations']; onClose(): void;
  archivedRelations: ArchivedNoteRelation[];
  project?: ProjectBubbleContext; threadToLocate: { key: string } | null;
  onBoardChange(): Promise<void>;
  online: boolean;
  onAnnotate(body: string): Promise<void>; onLink(targetNodeId: string): Promise<void>; onArchive(): Promise<void>; onOpenArchivedNote(noteId: string): void;
  editStatus?: import('./noteAutosave.js').NoteEdit;
  onRetrySave(): void;
  onResolveConflict(id: string, keepLocal: boolean): void;
  onSelectLink(id: string): void; onDeleteLink(id: string): void; selectedLinkId: string | null;
}) {
  const [annotation, setAnnotation] = useState('');
  const [linkTarget, setLinkTarget] = useState('');
  const [tab, setTab] = useState<'overview' | 'threads' | 'notes' | 'more' | 'content' | typeof projectSecondaryTabs[number][0]>(node.kind === 'note' ? 'content' : threadToLocate && project ? 'threads' : 'overview');
  const scrollArea = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { if (scrollArea.current) scrollArea.current.scrollTop = 0; }, [tab]);
  const secondaryTitle = project && projectSecondaryTabs.find(([id]) => id === tab)?.[1];
  const secondaryHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (secondaryTitle) secondaryHeading.current?.focus(); }, [secondaryTitle]);
  const [detailThreadKey, setDetailThreadKey] = useState<string | null>(threadToLocate?.key ?? null);
  const [updatedThreads, setUpdatedThreads] = useState<{ projectKey: string; keys: string[] }>({ projectKey: '', keys: [] });
  const updatedThreadKeys = updatedThreads.projectKey === project?.project.projectKey ? updatedThreads.keys : [];
  function showThread(key: string) {
    if (!project?.threads.some(item => item.threadKey === key)) return onNotice('当前项目没有这条来源对话。');
    setDetailThreadKey(key); setTab('threads');
  }
  const dirty = Boolean(editStatus && editStatus.sequence !== editStatus.savedSequence);
  useEffect(() => {
    setDetailThreadKey(threadToLocate?.key ?? null);
    if (threadToLocate && project) setTab('threads');
  }, [threadToLocate, project?.project.projectKey]);
  const tabs = node.kind === 'note'
    ? ([['content', '信息'], ['annotations', '批注'], ['links', '关联']] as const)
    : project
      ? ([['overview', '概览'], ['threads', '对话'], ['notes', '便签'], ['more', '更多']] as const)
      : ([['overview', '概览'], ['annotations', '批注'], ['links', '关联']] as const);
  const eyebrow = [manualPriorityLabel(displayedPriority(node)), project ? '' : node.kind === 'note' ? '本地便签' : '未归项目的对话'].filter(Boolean).join(' · ');
  const refreshUnavailable = project?.project.hostId !== undefined && project.project.hostId !== 'local'
    ? '远程项目可在 Codex 中运行全源同步。'
    : !canSummarize ? '请在「项目 → 项目更新 → 来源授权」允许本机读取与模型整理。' : '';
  return <aside className={`detail-panel panel-shell ${project ? 'project-detail-panel' : ''}`} inert={suppressConversation} aria-label={project ? '项目详情' : '便签或对话详情'}>
    <header className="panel-fixed-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}{node.kind === 'task' && <h2 className="detail-title">{project?.project.name || thread?.displayTitle || node.title}</h2>}</div><button className="panel-close" aria-label="关闭详情" onClick={onClose}>×</button>
      <nav className="panel-tabs" aria-label="详情分类">{tabs.map(([value, label]) => <button key={value} aria-current={tab === value || (value === 'more' && Boolean(secondaryTitle))} onClick={() => setTab(value)}>{label}</button>)}</nav>
    </header>
    <div ref={scrollArea} className="panel-scroll">
    {secondaryTitle && <h3 tabIndex={-1} ref={secondaryHeading} className="project-secondary-title">{secondaryTitle}</h3>}
    {tab === 'more' && project && <nav className="project-more-links" aria-label="更多项目内容">
      {projectSecondaryTabs.map(([id, label]) => <button type="button" key={id} onClick={() => setTab(id)}>{label}<span aria-hidden="true">›</span></button>)}
    </nav>}
    {project && <ProjectRefreshStatus key={`refresh:${project.project.projectKey}`} projectKey={project.project.projectKey} revision={boardRevision}
      showOverview={tab === 'overview'} showControls={tab === 'more'} onOpenPermissions={(!project.project.hostId || project.project.hostId === 'local') && !canSummarize ? onOpenPermissions : undefined}
      unavailableReason={refreshUnavailable} online={online && !suppressConversation} readOnly={readOnly} onBoardChange={onBoardChange}
      onUpdatedThreads={keys => setUpdatedThreads({ projectKey: project.project.projectKey, keys })} onFocusThread={showThread} />}
    {tab === 'overview' && (project ? <ProjectDetail context={project} focusedThreadKey={detailThreadKey} updatedThreadKeys={updatedThreadKeys} view="overview" onFocusThread={showThread} canReadSource={online && canReadSource && !suppressConversation} /> : thread && <ThreadSummary thread={thread} focused />)}
    {tab === 'overview' && projectNotes?.(() => setTab('notes'))}
    {!online && !node.id.startsWith('offline-note:') && <p className="offline-panel-note">{readOnly ? '归档页面只读；显示已保存的内容，恢复后可以编辑。' : '本地服务尚未连接；便签编辑先保留在本机恢复草稿。'}</p>}
    {project && tab === 'timeline' && !suppressConversation && <ConversationHistory key={`conversations:${project.project.projectKey}`} projectKey={project.project.projectKey} projectName={project.project.name} online={online} revision={boardRevision} onLocateThread={showThread} />}
    {tab === 'notes' && projectNotes?.()}
    {project && tab === 'timeline' && <ProjectTimeline key={`timeline:${project.project.projectKey}`} projectKey={project.project.projectKey} online={online && !suppressConversation} revision={boardRevision} />}
    {tab === 'overview' && archivedRelations.length > 0 && <button className="previous-note-entry" onClick={() => setTab('links')}>之前的便签 · {archivedRelations.length} <span aria-hidden="true">→</span></button>}
    {tab === 'threads' && project && <ProjectDetail key={detailThreadKey} context={project} focusedThreadKey={detailThreadKey} updatedThreadKeys={updatedThreadKeys} view="threads" canReadSource={online && canReadSource && !suppressConversation} />}
    {tab === 'content' && node.kind === 'note' && <>
      <NoteMetadata note={node} pending={dirty || node.id.startsWith('offline-note:')} />
      {editStatus?.error && <small className="note-save-status" role="alert">{editStatus.error}</small>}
      {noteActions}
      {editStatus?.status === 'error' && <button onClick={onRetrySave}>重试保存</button>}
      {editStatus?.status === 'conflict' && <div className="note-conflict"><button onClick={() => onResolveConflict(node.id, true)}>用本机文字覆盖服务端</button><button onClick={() => onResolveConflict(node.id, false)}>采用服务端文字</button></div>}
      <button className="archive-note-button" disabled={!online || node.id.startsWith('offline-note:')} onClick={onArchive}>归档这张便签</button></>}
    {tab === 'annotations' && <section className="annotation-section"><h3>边上写两句</h3>{annotations.map((item) => <blockquote key={item.id}>{item.body}</blockquote>)}
      <textarea value={annotation} disabled={!online} onChange={(event) => setAnnotation(event.target.value)} placeholder={online ? '这条批注只留在本地…' : '恢复连接后可添加批注'} />
      <button disabled={!online} onClick={async () => { await onAnnotate(annotation); setAnnotation(''); }}>加批注</button>
    </section>}
    {tab === 'links' && <FoldedNoteSection notes={foldedNotes} online={online} onUnfold={onUnfold} />}
    {tab === 'links' && <section className="link-section"><h3>轻轻连起来</h3>
      {links.filter((link) => link.sourceNodeId === node.id || link.targetNodeId === node.id).map((link) => {
        const other = nodes.find((item) => item.id === (link.sourceNodeId === node.id ? link.targetNodeId : link.sourceNodeId));
        return <div className={`relation-row${selectedLinkId === link.id ? ' is-selected' : ''}`} key={link.id}>
          <button onClick={() => other && pageId(other) !== pageId(node) ? onLocate(other) : onSelectLink(link.id)}>{other?.kind === 'note' ? other.body.slice(0, 50) || '空白便签' : other?.title || '另一个气泡'}{other?.foldedIntoNodeId ? ' · 已收纳' : ''}{other && pageId(other) !== pageId(node) ? ` · ${pages.find(page => page.id === pageId(other))?.name || '其他页'} →` : ''}</button>
          <button className="relation-delete" disabled={!online} aria-label="删除这条连线" title="删除连线（可撤销）" onClick={() => onDeleteLink(link.id)}>×</button>
        </div>;
      })}
      <select value={linkTarget} disabled={!online} onChange={(event) => setLinkTarget(event.target.value)}><option value="">选择另一个气泡…</option>{nodes.filter((item) => item.id !== node.id && pageId(item) === pageId(node)).map((item) => <option key={item.id} value={item.id}>{item.title || '无标题便签'}</option>)}</select>
      <button disabled={!online || !linkTarget} onClick={async () => { await onLink(linkTarget); setLinkTarget(''); }}>建立软关联</button>
    </section>}
    {tab === 'links' && archivedRelations.length > 0 && <section className="previous-note-section"><h3>之前的便签</h3>
      {archivedRelations.map((relation) => <article key={relation.note.id}><p>{noteDisplayText(relation.note) || '空白便签'}</p><small>归档于 {new Date(relation.note.archivedAt!).toLocaleString('zh-CN')}</small><button onClick={() => onOpenArchivedNote(relation.note.id)}>在归档中查看</button></article>)}
    </section>}
    </div>
  </aside>;
}

function Modal({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal panel-shell"><header className="modal-fixed-header"><h2>{title}</h2><button className="panel-close" onClick={onClose}>×</button></header><div className="modal-scroll">{children}</div></section></div>;
}
function PairCurator({ onPair }: { onPair(id: string): Promise<void> }) {
  const [id, setId] = useState('');
  return <div className="pair-box"><strong>先配对一条专用 Codex 任务</strong><input value={id} onChange={(event) => setId(event.target.value)} placeholder="粘贴顾问任务 ID" /><button disabled={!id.trim()} onClick={() => onPair(id.trim())}>配对</button></div>;
}

function toFlowNodes(board: BoardState, selectedIds: readonly string[], onResizeEnd: BubbleData['onResizeEnd'], offline: boolean): Node<BubbleData>[] {
  return visibleCanvasRecords(board).map((record) => ({
    id: record.id, type: 'bubble', ...canvasNodeGeometry(record), zIndex: record.zIndex,
    selected: selectedIds.includes(record.id),
    draggable: (!offline && board.nodes.some((node) => node.id === record.id)) || record.id.startsWith('offline-note:'),
    data: { record, project: contextForNode(board, record), thread: board.threads.find((item) => item.threadKey === record.threadKey), annotationCount: board.annotations.filter((item) => item.targetNodeId === record.id && !item.resolved).length, selected: selectedIds.includes(record.id), canResize: (!offline && board.nodes.some((node) => node.id === record.id)) || record.id.startsWith('offline-note:'), onResizeEnd }
  }));
}
function effectiveNodeSkinManifest(manifests: readonly SkinManifest[], board: BoardState | null, record: CanvasNodeRecord, componentId: 'taskBubble' | 'note'): SkinManifest | undefined {
  const explicit = manifestForReference(manifests, record.skinRef);
  if (explicit && getSkinComponent(explicit, componentId)) return explicit;
  return skinComponentManifest(manifests, board?.settings.activeSkinRef, componentId, board?.settings.skinComponents[componentId]);
}
function isTyping(target: EventTarget | null): boolean { return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && (target.isContentEditable || Boolean(target.closest('[role="textbox"]')))); }
function formatAge(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '时间未知';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / 86_400_000));
  return days < 1 ? '今天' : `${days} 天前`;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function bubbleLabel(node: Node<BubbleData>): string {
  const value = node.data.record.kind === 'note'
    ? noteDisplayText(node.data.record)
    : taskDisplayTitle(node.data.thread, node.data.record, node.data.project?.project);
  const clean = value.replace(/\s+/g, ' ').trim() || (node.data.record.kind === 'note' ? '空白便签' : '未命名气泡');
  return clean.length > 24 ? `${clean.slice(0, 24)}…` : clean;
}
function boardRevision(board: BoardState): number {
  const revision = Number((board as BoardState & { boardRevision?: unknown }).boardRevision);
  return Number.isFinite(revision) ? revision : 0;
}
