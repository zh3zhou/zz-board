import type { Node } from '@xyflow/react';
import type { CanvasNodeRecord } from '../shared/schema.js';

/** Saved geometry is already known; visibility must not wait for DOM measurement. */
export function canvasNodeGeometry(record: Pick<CanvasNodeRecord, 'x' | 'y' | 'width' | 'height'>): Pick<Node, 'position' | 'width' | 'height' | 'style'> {
  return {
    position: { x: record.x, y: record.y },
    width: record.width,
    height: record.height,
    style: { width: record.width, height: record.height }
  };
}
