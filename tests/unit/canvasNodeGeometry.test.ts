import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { canvasNodeGeometry } from '../../src/web/canvasNodeGeometry.js';

const nodeTypes = { probe: () => createElement('div', null, 'synthetic content') };

function renderNode(node: Node): string {
  const html = renderToStaticMarkup(createElement(ReactFlowProvider, {
    initialNodes: [node], initialWidth: 800, initialHeight: 600,
    children: createElement(ReactFlow, { nodes: [node], nodeTypes, width: 800, height: 600 })
  }));
  const wrapper = html.split('<').find(tag => tag.includes('data-id="synthetic-node"'));
  expect(wrapper).toBeDefined();
  expect(html).toContain('synthetic content');
  return wrapper!;
}

describe('canvas node visibility before ResizeObserver measurements', () => {
  it.each([
    { x: 20, y: 30, width: 220, height: 150 },
    { x: -1800, y: 900, width: 112, height: 88 },
    { x: 10, y: 10, width: 420, height: 343 }
  ])('shows a saved or draft node without DOM measurements: %j', record => {
    const geometry = canvasNodeGeometry(record);
    const node = { id: 'synthetic-node', type: 'probe', data: {}, ...geometry };
    expect(renderNode(node)).toContain('visibility:visible');
    expect(geometry.position).toEqual({ x: record.x, y: record.y });
    expect(geometry.style).toEqual({ width: record.width, height: record.height });
  });

  it('stays visible when a reload replaces measured nodes with saved geometry', () => {
    const record = { x: 20, y: 30, width: 220, height: 150 };
    const measured: Node = { id: 'synthetic-node', type: 'probe', data: {}, ...canvasNodeGeometry(record), measured: { width: 220, height: 150 } };
    expect(renderNode(measured)).toContain('visibility:visible');
    const reloaded: Node = { id: measured.id, type: measured.type, data: {}, ...canvasNodeGeometry(record) };
    expect(reloaded.measured).toBeUndefined();
    expect(renderNode(reloaded)).toContain('visibility:visible');
  });

  it('uses the latest saved dimensions after a resize and reload', () => {
    const record = { x: -25, y: 70, width: 340, height: 240 };
    const geometry = canvasNodeGeometry(record);
    const node: Node = { id: 'synthetic-node', type: 'probe', data: {}, ...geometry };
    const wrapper = renderNode(node);
    expect(wrapper).toContain('visibility:visible');
    expect(wrapper).toContain('width:340px');
    expect(wrapper).toContain('height:240px');
  });
});
