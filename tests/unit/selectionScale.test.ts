import { expect, it } from 'vitest';
import { cornerScale, scaledNode, scaledNodePreview, scaledInk, selectionScaleLimits } from '../../src/shared/selectionScale.js';
import type { CanvasNodeRecord, InkStrokeRecord } from '../../src/shared/schema.js';
const node = { x: 20, y: 30, width: 220, height: 180, contentScale: 1, body: '中  文\n\n下一行' } as CanvasNodeRecord;
const ink = { size: 20, points: [{ x: 10, y: 30, pressure: .6 }] } as InkStrokeRecord;
it('scales the composition uniformly while preserving line layout, text and pressure', () => {
  const transform = { origin: { x: 0, y: 10 }, factor: 2 };
  const result = scaledNode(node, transform);
  expect(result).toMatchObject({ x: 40, y: 50, width: 440, height: 360, contentScale: 2, body: node.body });
  expect(result.width / result.contentScale!).toBe(node.width);
  expect(scaledInk(ink, transform)).toMatchObject({ size: 40, points: [{ x: 20, y: 50, pressure: .6 }] });
  expect(scaledNode(result, { ...transform, factor: .5 })).toEqual(node);
});
it('uses one common limit and cannot flip across the fixed opposite corner', () => {
  const limits = selectionScaleLimits([node], [{ ...ink, size: 128 }]);
  expect(limits).toEqual({ min: .125, max: 2 });
  expect(cornerScale({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 200 }, limits).factor).toBe(2);
  expect(cornerScale({ x: 0, y: 0 }, { x: 100, y: 100 }, { x: -1, y: -1 }, limits).factor).toBe(.125);
});
it('keeps not-yet-saved note text and rich content visible throughout the preview', () => {
  const current = { ...node, body: '刚写下的内容', noteDocument: { version: 1 as const, content: [{ type: 'text' as const, text: '刚写下的内容' }] } };
  expect(scaledNodePreview(node, current, { origin: { x: 0, y: 0 }, factor: 2 })).toMatchObject({ body: current.body, noteDocument: current.noteDocument, width: 440, contentScale: 2 });
});
