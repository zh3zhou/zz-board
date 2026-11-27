import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { Background, BackgroundVariant, ReactFlow, useReactFlow, useStore, type Edge, type NodeChange, type Viewport } from '@xyflow/react';
import type { InkStrokeRecord } from '../shared/schema.js';
import { FloatingLinkEdge } from '../web/FloatingLinkEdge.js';
import { InkCanvas, type InkCanvasTool, type InkEraseAction, type NewInkStroke } from '../web/InkCanvas.js';
import {
  BOOK_FAIR_ID, BOOK_FAIR_SOURCES, connectTrialNodes, MAX_TRIAL_IMAGES_PER_NOTE, pastedImage,
  prepareTrialImage, removeTrialNote, type TrialNote, type TrialPosition
} from './model.js';
import { TrialNodeCard, type TrialNode } from './TrialNodes.js';
import { useTrialBoard, type SaveStatus } from './useTrialBoard.js';

type TrialTool = Exclude<InkCanvasTool, 'lasso'> | 'link';
const nodeTypes = { trial: TrialNodeCard };
const edgeTypes = { floating: FloatingLinkEdge };
const tools: { id: TrialTool; label: string }[] = [
  { id: 'select', label: '选取' }, { id: 'pen', label: '画笔' },
  { id: 'highlighter', label: '荧光笔' }, { id: 'eraser', label: '橡皮' }, { id: 'link', label: '连线' }
];
const saveLabels: Record<SaveStatus, string> = {
  loading: '正在读取画布…',
  saved: '已保存到此浏览器',
  saving: '正在保存…',
  unavailable: '本地存储无法读取。改动仅在此页面保留。',
  failed: '保存失败，改动仍在此页面。',
  conflict: '另一标签页已保存。请先复制需要保留的改动，再刷新。'
};
const noteTones: TrialNote['tone'][] = ['paper', 'green', 'rose'];

function ProjectEvidence({ onClose }: { onClose(): void }) {
  return <aside className="trial-evidence" aria-label="春日书展项目近况">
    <header className="trial-evidence__header">
      <div><p>合成项目 · 书展导览册</p><h2>春日书展</h2></div>
      <button className="trial-close" aria-label="关闭项目近况" onClick={onClose}>×</button>
    </header>
    <section className="trial-evidence__next">
      <h3>接下来</h3>
      <p>自然光下比较两张封面纸样，再决定印哪张。</p>
    </section>
    <section className="trial-evidence__sources" aria-label="进展与对话出处">
      <h3>进展与对话出处</h3>
      {BOOK_FAIR_SOURCES.map((source) => <details key={source.title}>
        <summary>
          <small>{source.time}</small>
          <strong>{source.title}</strong>
        </summary>
        <p>{source.result}</p>
        <blockquote>{source.excerpt}</blockquote>
      </details>)}
    </section>
  </aside>;
}

export function TrialBoardView() {
  const { board, update, readImage, status, retry } = useTrialBoard();
  const [tool, setTool] = useState<TrialTool>('select');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [linkSource, setLinkSource] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [draggingPositions, setDraggingPositions] = useState<Record<string, TrialPosition>>({});
  const [projectOpen, setProjectOpen] = useState(false);
  const stage = useRef<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const fileTarget = useRef<string | null>(null);
  const importingImage = useRef(false);
  const flow = useReactFlow<TrialNode, Edge>();
  const zoom = useStore((state) => state.transform[2]);
  const selectedNote = board?.notes.find((note) => note.id === selected);
  const inkMode = tool === 'link' ? 'select' : tool;
  const drawing = inkMode !== 'select';

  function chooseTool(next: TrialTool) {
    setTool(next);
    setLinkSource(null);
    setSelectedEdge(null);
    if (next !== 'select') setEditing(null);
    setNotice('');
  }

  function centerPosition(): TrialPosition {
    const rect = stage.current!.getBoundingClientRect();
    const middle = flow.screenToFlowPosition({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
    return { x: middle.x - 113, y: middle.y - 50 };
  }

  function newNote(position = centerPosition()) {
    const id = crypto.randomUUID();
    update((current) => ({
      ...current,
      notes: [...current.notes, { id, position, body: '', images: [], tone: noteTones[current.notes.length % noteTones.length] }]
    }));
    setSelected(id);
    setEditing(id);
    setProjectOpen(false);
    chooseTool('select');
  }

  function selectNode(id: string) {
    setSelected(id);
    setSelectedEdge(null);
    setNotice('');
    if (tool === 'link') {
      if (!linkSource) { setLinkSource(id); return; }
      const newId = crypto.randomUUID();
      const linked = connectTrialNodes(board!, newId, linkSource, id);
      if (linked === board) {
        setNotice(id === linkSource ? '请选择另一张便签或项目。' : '这两个对象已有连线。');
        return;
      }
      update((current) => connectTrialNodes(current, newId, linkSource, id));
      chooseTool('select');
      return;
    }
    setProjectOpen(id === BOOK_FAIR_ID);
    if (editing !== id) setEditing(null);
  }

  function startEditing(id: string) {
    if (tool !== 'select' || id === BOOK_FAIR_ID) return;
    setSelected(id);
    setEditing(id);
    setProjectOpen(false);
    setNotice('');
  }

  function updateNote(id: string, body: string) {
    update((current) => ({
      ...current, notes: current.notes.map((note) => note.id === id ? { ...note, body } : note)
    }));
  }

  function deleteNote(note: TrialNote) {
    if (!window.confirm('删除这张便签、图片和它的连线？')) return;
    update((current) => removeTrialNote(current, note.id), new Map(note.images.map((id) => [id, null])));
    setSelected(null);
    setEditing(null);
  }

  async function addImage(file: File, target: string | null) {
    if (importingImage.current) { setNotice('上一张图片正在读取，请稍后重试。'); return; }
    importingImage.current = true;
    setNotice('正在读取图片…');
    const position = centerPosition();
    try {
      const blob = await prepareTrialImage(file);
      const imageId = crypto.randomUUID();
      const noteId = target ?? crypto.randomUUID();
      update((current) => {
        const note = current.notes.find((item) => item.id === target);
        if (target && !note) { setNotice('原便签已删除，请选一张便签再贴图。'); return current; }
        if (note && note.images.length >= MAX_TRIAL_IMAGES_PER_NOTE) {
          setNotice('这张便签已放满图片。请新建一张便签继续。');
          return current;
        }
        setNotice('');
        if (!note) {
          return { ...current, notes: [...current.notes, { id: noteId, tone: 'paper', body: '', position, images: [imageId] }] };
        }
        return { ...current, notes: current.notes.map((item) => item === note ? { ...item, images: [...item.images, imageId] } : item) };
      }, new Map([[imageId, blob]]));
      if (!target) { setSelected(noteId); setProjectOpen(false); }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '图片读取失败，请选一张本机图片重试。');
    } finally { importingImage.current = false; }
  }

  function handlePaste(event: ClipboardEvent<HTMLElement>) {
    const file = pastedImage(event.clipboardData);
    if (!file) return;
    event.preventDefault();
    void addImage(file, selectedNote?.id ?? null);
  }

  function chooseImage() {
    fileTarget.current = selectedNote?.id ?? null;
    fileInput.current?.click();
  }

  function handleNodeChanges(changes: NodeChange<TrialNode>[]) {
    const positions = changes.filter((change) => change.type === 'position').filter(({ position }) => position);
    if (!positions.length) return;
    setDraggingPositions((previous) => {
      const next = { ...previous };
      for (const { id, position, dragging } of positions) {
        if (dragging) next[id] = position!;
        else delete next[id];
      }
      return next;
    });
    const finished = new Map(positions.filter((position) => !position.dragging).map(({ id, position }) => [id, position!]));
    if (finished.size) update((current) => ({
      ...current,
      projectPosition: finished.get(BOOK_FAIR_ID) ?? current.projectPosition,
      notes: current.notes.map((note) => {
        const position = finished.get(note.id);
        return position ? { ...note, position } : note;
      })
    }));
  }

  function drawStroke(input: NewInkStroke) {
    const time = new Date().toISOString();
    const stroke: InkStrokeRecord = { ...input, revision: 0, createdAt: time, updatedAt: time };
    update((current) => ({ ...current, strokes: [...current.strokes.filter(({ id }) => id !== stroke.id), stroke] }));
  }

  function eraseStrokes(actions: InkEraseAction[]) {
    const erased = new Set(actions.map(({ strokeId }) => strokeId));
    update((current) => ({ ...current, strokes: current.strokes.filter(({ id }) => !erased.has(id)) }));
  }

  function rememberViewport(viewport: Viewport) {
    update((current) => ({ ...current, viewport }));
  }

  async function moveViewport(move: () => Promise<boolean>) {
    if (await move()) rememberViewport(flow.getViewport());
  }

  function handleKey(event: KeyboardEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey ||
        target.closest('input, textarea, button, summary, [contenteditable=true]')) return;
    if (event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newNote();
    } else if (event.key === 'Enter') {
      const id = target.closest<HTMLElement>('.react-flow__node')?.dataset.id;
      if (!id) return;
      event.preventDefault();
      if (tool === 'link' || id === BOOK_FAIR_ID) selectNode(id);
      else startEditing(id);
    } else if (event.key === 'Escape') {
      chooseTool('select');
      setProjectOpen(false);
    }
  }

  const shared = { readImage, onEdit: updateNote, onFinish: (id: string) => setEditing((latest) => latest === id ? null : latest) };
  const nodes: TrialNode[] = !board ? [] : [
    {
      id: BOOK_FAIR_ID, type: 'trial', position: draggingPositions[BOOK_FAIR_ID] ?? board.projectPosition,
      selected: selected === BOOK_FAIR_ID, ariaLabel: '春日书展，打开项目近况',
      data: { ...shared, linking: linkSource === BOOK_FAIR_ID }
    },
    ...board.notes.map<TrialNode>((note) => ({
      id: note.id, type: 'trial', position: draggingPositions[note.id] ?? note.position,
      selected: selected === note.id, draggable: editing !== note.id && tool === 'select',
      ariaLabel: note.body.trim() ? '便签 ' + note.body.trim().slice(0, 80) : '空白便签',
      data: { ...shared, note, editing: editing === note.id, linking: linkSource === note.id }
    }))
  ];
  const edges: Edge[] = (board?.links ?? []).map(({ id, source, target }) => ({
    id, source, target, type: 'floating', selected: selectedEdge === id,
    style: { stroke: 'var(--edge)' },
    data: {
      sourceKind: source === BOOK_FAIR_ID ? 'task' : 'note',
      targetKind: target === BOOK_FAIR_ID ? 'task' : 'note',
      onDelete: (edgeId: string) => {
        update((current) => ({ ...current, links: current.links.filter((link) => link.id !== edgeId) }));
        setSelectedEdge(null);
      }
    }
  }));

  return <main className="trial-shell" onKeyDown={handleKey} onPaste={handlePaste}>
    <header className="trial-header">
      <div className="trial-brand">
        <span className="trial-brand__mark" aria-hidden="true" />
        <div><h1>ZZ Board</h1><span>网页试用</span></div>
      </div>
      <div className="trial-tools" role="toolbar" aria-label="画布工具">
        {tools.map(({ id, label }) => <button key={id} type="button" aria-pressed={tool === id} disabled={!board}
          onClick={() => chooseTool(id)}>{label}</button>)}
      </div>
      <div className="trial-header__actions">
        <button className="trial-secondary" type="button" disabled={!board} onClick={chooseImage}>贴图</button>
        <button className="trial-primary" type="button" disabled={!board} onClick={() => newNote()}>
          <span aria-hidden="true">＋</span> 新建便签
        </button>
        <input type="file" ref={fileInput} hidden accept="image/png,image/jpeg,image/webp" onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void addImage(file, fileTarget.current);
          event.target.value = '';
        }} />
      </div>
    </header>

    <div className="trial-stage" ref={stage} data-tool={tool} aria-label="试用画布" onDoubleClick={(event) => {
      if (board && tool === 'select' && (event.target as Element).classList?.contains('react-flow__pane')) {
        newNote(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
      }
    }}>
      {board && <ReactFlow<TrialNode, Edge>
        nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={handleNodeChanges}
        onNodeClick={(_event, node) => { if (!drawing) selectNode(node.id); }}
        onNodeDoubleClick={(_event, node) => startEditing(node.id)}
        onEdgeClick={(_event, edge) => { if (tool === 'select') { setSelected(null); setSelectedEdge(edge.id); } }}
        onPaneClick={() => {
          setSelected(null);
          setSelectedEdge(null);
          setEditing(null);
          setProjectOpen(false);
        }}
        onMoveEnd={(event, viewport) => { if (event) rememberViewport(viewport); }}
        minZoom={0.2} maxZoom={2.5} fitView={board.viewport === null} fitViewOptions={{ maxZoom: 1.1, padding: 0.17 }}
        defaultViewport={board.viewport ?? { x: 0, y: 0, zoom: 1 }}
        nodesDraggable={tool === 'select'} nodesConnectable={false} deleteKeyCode={null}
        zoomOnDoubleClick={false} panOnDrag={!drawing} selectionOnDrag={false}
        proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#a58a6955" />
        <InkCanvas strokes={board.strokes} tool={inkMode} zoom={zoom} selectedInkIds={[]} eraserMode="whole" lassoMode="inkOnly"
          preset={{ color: inkMode === 'highlighter' ? '#e3b45c' : '#73604b', size: inkMode === 'highlighter' ? 12 : 2.8,
            opacity: inkMode === 'highlighter' ? 0.47 : 1, layer: 'foreground' }}
          screenToWorld={flow.screenToFlowPosition} onCreateStroke={drawStroke} onErase={eraseStrokes}
          onSelectInk={() => {}} onLassoComplete={() => {}} />
      </ReactFlow>}

      {tool === 'link' && <div className="trial-link-hint" role="status">
        {linkSource ? '再点另一张便签或项目。' : '点第一张便签或项目。'}
      </div>}

      {selectedNote && tool === 'select' && !editing && <div className="trial-note-actions" aria-label="所选便签">
        <button onClick={() => startEditing(selectedNote.id)}>编辑便签</button>
        <button onClick={chooseImage}>添加图片</button>
        <button className="trial-delete" onClick={() => deleteNote(selectedNote)}>删除便签</button>
      </div>}
      {projectOpen && <ProjectEvidence onClose={() => setProjectOpen(false)} />}

      <div className="trial-stage__bottom">
        <div className="trial-local">
          <div className={'trial-save trial-save--' + status} role="status">
            <span className="trial-save__dot" aria-hidden="true" />{saveLabels[status]}
            {status === 'failed' && <button onClick={() => void retry()}>重试保存</button>}
          </div>
          {notice && <p className="trial-notice" role="status">{notice}</p>}
        </div>
        {board && <div className="trial-zoom" aria-label="画布缩放">
          <button type="button" aria-label="缩小" onClick={() => void moveViewport(() => flow.zoomOut({ duration: 120 }))}>−</button>
          <output>{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="放大" onClick={() => void moveViewport(() => flow.zoomIn({ duration: 120 }))}>＋</button>
          <button type="button" onClick={() => void moveViewport(() => flow.fitView({ duration: 150, padding: 0.17, maxZoom: 1.1 }))}>全览</button>
        </div>}
      </div>
    </div>
  </main>;
}
