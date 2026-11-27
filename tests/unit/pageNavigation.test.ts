import { isValidElement, type ReactNode, type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { CanvasPageRecord } from '../../src/shared/pages.js';
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (value: unknown) => [value, vi.fn()] }));
import { PageNavigation } from '../../src/web/PageNavigation.js';

function page(id: string, archivedAt: string | null = null): CanvasPageRecord {
  return { id, name: id, archivedAt, sortOrder: 0, viewport: { x: 0, y: 0, zoom: 1 }, backgroundSkinRef: null, autoCheckPaused: false, revision: 0, createdAt: '', updatedAt: '' };
}
function elements(node: ReactNode): Array<ReactElement<Record<string, any>>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
describe('page navigation controls', () => {
  it('reorders only activity pages when an archived page sits between them', () => {
    const onReorder = vi.fn();
    const tree = PageNavigation({ pages: [page('first'), page('archived', '2026-11-17'), page('second')], currentId: 'first', defaultId: 'first', online: true, backgrounds: [],
      onSwitch() {}, onCreate() {}, onRename() {}, onArchive() {}, onDefault() {}, onDelete() {}, onReorder, onBackground() {}, onContinue() {} });
    elements(tree).find(element => element.props['aria-label'] === '上移second')!.props.onClick();
    expect(onReorder).toHaveBeenCalledWith(['second', 'first']);
  });
  it('shows archived page navigation and a distinct restore action', () => {
    const onSwitch = vi.fn(), onArchive = vi.fn(), archived = page('old', '2026-11-17');
    const tree = PageNavigation({ pages: [page('active'), archived], currentId: 'old', defaultId: 'active', online: true, backgrounds: [],
      onSwitch, onCreate() {}, onRename() {}, onArchive, onDefault() {}, onDelete() {}, onReorder() {}, onBackground() {}, onContinue() {} });
    const buttons = elements(tree).filter(element => element.type === 'button');
    buttons.find(element => Array.isArray(element.props.children) && element.props.children[0] === 'old')!.props.onClick();
    expect(onSwitch).toHaveBeenCalledWith('old');
    buttons.find(element => element.props.children === '恢复页面（检查保持暂停）')!.props.onClick();
    expect(onArchive).toHaveBeenCalledWith(archived, false);
  });
});
