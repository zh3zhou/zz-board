import { isValidElement, type ReactElement } from 'react';
import { expect, it, vi } from 'vitest';
import { TaskBubble } from '../../src/web/TaskBubble.js';

vi.mock('react', async original => ({
  ...await original<typeof import('react')>(), useLayoutEffect: () => {}, useId: () => 'resize-test-viewport',
  useState: (initial: unknown) => [initial, vi.fn()], useRef: (current: unknown) => ({ current }),
}));

function findResize(element: unknown): ReactElement<{ onResizeEnd(event: unknown, dimensions: unknown): void }> | null {
  if (Array.isArray(element)) return element.map(findResize).find(Boolean) || null;
  if (!isValidElement<{ children?: unknown; onResizeEnd?: unknown }>(element)) return null;
  if (element.props.onResizeEnd) return element as ReactElement<{ onResizeEnd(event: unknown, dimensions: unknown): void }>;
  return findResize(element.props.children);
}

it('passes the native touch event through resize completion so cancelled resizing cannot save', () => {
  const onResizeEnd = vi.fn();
  const tree = TaskBubble({ id: 'note:test', data: {
    record: { id: 'note:test', kind: 'note', body: '中文', title: '', x: 0, y: 0, width: 180, height: 180, revision: 1, zIndex: 1 },
    selected: true, canResize: true, onResizeEnd,
  } });
  const resize = findResize(tree); expect(resize).not.toBeNull();
  const sourceEvent = new Event('touchend');
  resize!.props.onResizeEnd({ sourceEvent }, { width: 200, height: 150 });
  expect(onResizeEnd).toHaveBeenCalledWith('note:test', 200, 150, sourceEvent);
});
