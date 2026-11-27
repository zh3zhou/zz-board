import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider, applyNodeChanges, type Node, type NodeChange } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { TaskBubble, type BubbleData } from '../../src/web/TaskBubble.js';
import { canvasNodeGeometry } from '../../src/web/canvasNodeGeometry.js';
import type { CanvasNodeRecord } from '../../src/shared/schema.js';
import '../../src/web/styles.css';

// Synthetic UI only: no board API, private state or model calls.
const NativeResizeObserver = window.ResizeObserver;
let measurementsPaused = true;
const observers = new Set<DeferredResizeObserver>();
class DeferredResizeObserver implements ResizeObserver {
  private native: ResizeObserver;
  private pending: ResizeObserverEntry[] = [];
  constructor(private callback: ResizeObserverCallback) {
    observers.add(this);
    this.native = new NativeResizeObserver(entries => {
      if (measurementsPaused) this.pending = entries;
      else callback(entries, this);
    });
  }
  observe(target: Element, options?: ResizeObserverOptions) { this.native.observe(target, options); }
  unobserve(target: Element) { this.native.unobserve(target); }
  disconnect() { this.native.disconnect(); observers.delete(this); }
  flush() { if (this.pending.length) { const entries = this.pending; this.pending = []; this.callback(entries, this); } }
}
window.ResizeObserver = DeferredResizeObserver;
const nodeTypes = { bubble: TaskBubble };
const records: CanvasNodeRecord[] = [
  { id: 'synthetic-task', kind: 'task', threadKey: null, title: '合成项目气泡', body: '', x: 30, y: 40, width: 160, height: 160, zIndex: 1, revision: 1, lastViewedAt: null, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' },
  { id: 'synthetic-note', kind: 'note', threadKey: null, title: '', body: '合成便签\n首次测量延迟时仍应可见。', x: 270, y: 70, width: 220, height: 150, zIndex: 2, revision: 1, lastViewedAt: null, createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:00:00Z' }
];
function createNodes(fixed: boolean, enlarged = false): Node<BubbleData>[] {
  return records.map(source => {
    const record = enlarged && source.kind === 'note' ? { ...source, width: 300, height: 200 } : { ...source };
    return { id: record.id, type: 'bubble', ...(fixed ? canvasNodeGeometry(record) : { position: { x: record.x, y: record.y }, style: { width: record.width, height: record.height } }),
      data: { record, annotationCount: 0, selected: false, canResize: false, onResizeEnd: () => {} } };
  });
}
function Lane({ fixed }: { fixed: boolean }) {
  const [nodes, setNodes] = useState(() => createNodes(fixed));
  const [reloaded, setReloaded] = useState(0);
  return <section data-testid={fixed ? 'fixed-lane' : 'old-lane'} style={{ border: '1px solid #999', borderRadius: 12, padding: 14 }}>
    <h2>{fixed ? '修复后：保存的尺寸直接用于初始化' : '旧行为：只有 CSS 尺寸'}</h2>
    <button onClick={() => { setNodes(createNodes(fixed)); setReloaded(n => n + 1); }}>模拟重新连接</button>
    <button onClick={() => setNodes(createNodes(fixed, true))}>调整便签尺寸</button><span> 重连 {reloaded} 次</span>
    <div style={{ width: 580, height: 300, marginTop: 12, position: 'relative', background: 'var(--paper)' }}>
      <ReactFlowProvider initialNodes={nodes} initialWidth={580} initialHeight={300}>
        <ReactFlow nodes={nodes} nodeTypes={nodeTypes} width={580} height={300}
          edges={[{ id: 'synthetic-link', source: 'synthetic-task', target: 'synthetic-note' }]}
          defaultViewport={{ x: 10, y: 0, zoom: 1 }}
          onNodesChange={(changes: NodeChange<Node<BubbleData>>[]) => setNodes(current => applyNodeChanges(changes, current))}
          nodesDraggable={false} nodesConnectable={false} zoomOnScroll={false} panOnDrag={false} proOptions={{ hideAttribution: true }} />
      </ReactFlowProvider>
    </div>
  </section>;
}
function Harness() {
  const [paused, setPaused] = useState(true);
  return <main style={{ padding: 24, overflow: 'auto', height: '100%' }}>
    <h1>节点初始化与重连验收</h1><p>全部为合成内容；刻意延迟 ResizeObserver，模拟启动时测量尚未完成。</p>
    <button onClick={() => { measurementsPaused = !measurementsPaused; setPaused(measurementsPaused); if (!measurementsPaused) observers.forEach(observer => observer.flush()); }}>{paused ? '恢复尺寸测量' : '暂停尺寸测量'}</button>
    <p role="status">尺寸测量：{paused ? '暂停' : '正常'}</p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18 }}><Lane fixed={false} /><Lane fixed /></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
