import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { AllSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { NoteDocument } from '../../src/shared/noteDocument.js';
import { finishCanvasEditors, noteForClipboard } from '../../src/web/editorNavigation.js';

const harness = vi.hoisted(() => ({ effects: [] as Array<() => unknown>, refCount: 0, refs: [] as Array<{ current: unknown }>, stateCount: 0, state: [] as unknown[], editor: null as any, order: [] as string[] }));
const mediaHarness = vi.hoisted(() => ({ upload: vi.fn(), files: [] as File[] }));
vi.mock('../../src/web/mediaClient.js', () => ({ mediaUrl: (id: string) => `/api/media/${id}`, clipboardImages: () => mediaHarness.files, uploadImage: mediaHarness.upload }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useRef: (initial: unknown) => {
    const index = harness.refCount++;
    return harness.refs[index] ??= { current: index === 0 ? { contains: () => false } : initial };
  },
  useEffect: (effect: () => unknown) => { harness.effects.push(effect); },
  useLayoutEffect: (effect: () => unknown) => { harness.effects.push(effect); },
  useState: (initial: unknown) => {
    const index = harness.stateCount++;
    if (!(index in harness.state)) harness.state[index] = initial;
    return [harness.state[index], (value: unknown) => { harness.state[index] = value; }];
  }
}));
vi.mock('prosemirror-view', () => ({ EditorView: class {
  state: EditorState; pending: Transaction | null = null; destroyed = false; scheduled = true;
  dom = { blur: () => this.props.handleDOMEvents.blur(this, { relatedTarget: null }) };
  domObserver = {
    forceFlush: () => { harness.order.push('forceFlush'); if (this.scheduled) this.consumePending(); },
    flush: () => { harness.order.push('flush'); this.consumePending(); }
  };
  constructor(_host: unknown, public props: any) { this.state = props.state; harness.editor = this; }
  updateState(state: EditorState) { this.state = state; }
  consumePending() { if (this.pending) { const tr = this.pending; this.pending = null; this.props.dispatchTransaction(tr); } }
  dispatch(tr: Transaction) { this.props.dispatchTransaction(tr); }
  focus() { harness.order.push('focus'); }
  posAtCoords(point: { left: number; top: number }) { harness.order.push(`hit:${point.left},${point.top}`); return { pos: 3 }; }
  destroy() { harness.order.push('destroy'); this.destroyed = true; this.pending = null; }
  hasFocus() { return true; }
} }));

import NoteRichEditor, { toEditor } from '../../src/web/NoteRichEditor.js';

function mount(body = '', autoFocus = false, initialPoint?: { x: number; y: number }, dataStoreId?: string) {
  const changes: Array<{ body: string; document: NoteDocument }> = [];
  const onFinish = vi.fn(() => { harness.order.push('finish'); });
  const onComposition = vi.fn((active: boolean) => { harness.order.push(`composition:${active}`); });
  harness.refs = []; harness.state = [];
  function render() {
    harness.refCount = 0; harness.stateCount = 0;
    return NoteRichEditor({ noteId: 'note:synthetic-editor', body, online: true, autoFocus, initialPoint, dataStoreId, onChange: (body, document) => { harness.order.push('change'); changes.push({ body, document }); }, onComposition, onFinish });
  }
  render();
  const cleanup = harness.effects[0]!() as () => void;
  return { changes, onFinish, onComposition, cleanup, editor: harness.editor, render };
}
function pendingImageAction(tree: ReactNode, action: 'discard' | 'retry' = 'discard'): boolean {
  if (Array.isArray(tree)) return tree.some(item => pendingImageAction(item, action));
  if (!isValidElement<{ children?: ReactNode; onClick?(): void }>(tree)) return false;
  const matches = action === 'discard' ? tree.props.children === '放弃待添加图片'
    : Array.isArray(tree.props.children) && tree.props.children[0] === '重试添加 ';
  if (tree.type !== 'button' || !matches) return pendingImageAction(tree.props.children, action);
  tree.props.onClick!(); return true;
}
beforeEach(() => { harness.effects = []; harness.refCount = 0; harness.editor = null; harness.order = []; mediaHarness.upload.mockReset(); mediaHarness.files = []; });

describe('rich note final-input lifecycle (synthetic PM observer)', () => {
  it('finishes pending DOM input for whole-note clipboard reads and leaves an active IME composition untouched', () => {
    const { editor, changes, cleanup } = mount('句首');
    const previous = { id: 'note:synthetic-editor', body: '句首' };
    try {
      editor.composing = true;
      expect(() => noteForClipboard(previous)).toThrow('中文组字');
      expect(changes).toHaveLength(0);
      editor.composing = false; editor.pending = editor.state.tr.insertText('，刚输入。', 3);
      expect(noteForClipboard(previous).body).toBe('句首，刚输入。');
      expect(changes.map(change => change.body)).toEqual(['句首，刚输入。']);
    } finally { cleanup(); }
  });
  it('uses the point of the initial canvas click as the insertion caret', () => {
    const { editor, changes, cleanup } = mount('中文原句', true, { x: 90, y: 54 });
    expect(harness.order).toContain('hit:90,54');
    expect([editor.state.selection.from, editor.state.selection.to]).toEqual([3, 3]);
    expect(changes).toEqual([]); cleanup();
  });
  it('cuts and pastes the complete inline selection, keeping repeated images, anchors and placement', () => {
    const { editor, changes, cleanup } = mount();
    const image = { type: 'image' as const, assetId: 'f'.repeat(64), side: 'right' as const, width: 33 };
    const centered = { ...image, width:60, side:'left' as const, placement:{xPercent:20,offsetY:0}, wrap:'none' as const };
    const source: NoteDocument = { version: 1, content: [image, { type: 'text', text: '两图之间' }, centered, { ...image, placement: { xPercent: 60, offsetY: 15 } }] };
    const data = new Map<string, string>();
    const clipboardData = { getData: (key: string) => data.get(key) || '', setData: (key: string, value: string) => data.set(key, value) };
    const event = { type: 'cut', clipboardData, preventDefault() {} };
    try {
      editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, toEditor(source).content));
      editor.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      expect(editor.props.handleDOMEvents.cut(editor, event)).toBe(true);
      expect(changes.at(-1)?.document.content).toEqual([]);
      expect(data.get('text/plain')).toBe('两图之间');
      editor.props.handlePaste(editor, event);
      expect(changes.at(-1)?.document).toEqual(source);
      data.set('application/x-zz-board-fragment', JSON.stringify({window: 'a different open board', document: source}));
      editor.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      editor.props.handlePaste(editor, event);
      expect(changes.at(-1)?.document.content).toEqual([{ type: 'text', text: '两图之间' }]);
    } finally { cleanup(); }
  });
  it('permits a saved image fragment across windows only when the media store identity matches', () => {
    const {editor, changes, cleanup} = mount('', false, undefined, 'board-a');
    const img = {type: 'image' as const, assetId: 'e'.repeat(64), side: 'left' as const, width: 40, placement: {xPercent: 13, offsetY: 6}};
    const fragment: NoteDocument = {version: 1, content: [img]};
    const paste = (store: string) => editor.props.handlePaste(editor, {preventDefault() {}, clipboardData: {getData: (format: string) =>
      format === 'application/x-zz-board-fragment' ? JSON.stringify({store, window: 'another open window', document: fragment}) : '普通文字'}});
    try {
      paste('board-a'); expect(changes.at(-1)?.document).toEqual(fragment);
      editor.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)));
      paste('board-b'); expect(changes.at(-1)?.document.content).toEqual([{type: 'text', text: '普通文字'}]);
    } finally { cleanup(); }
  });
  it('focuses a saved long note at a collapsed start and keeps the whole document on the first paste', () => {
    const body = '开头\n' + '一段中文。\n'.repeat(300) + '末尾';
    const { editor, changes, cleanup } = mount(body, true);
    try {
      expect(harness.order).toContain('focus');
      expect([editor.state.selection.from, editor.state.selection.to]).toEqual([1, 1]);
      expect(changes).toHaveLength(0);
      editor.props.handlePaste(editor, { clipboardData: { getData: () => '新增' }, preventDefault() {} });
      expect(changes.map(change => change.body)).toEqual(['新增' + body]);
    } finally { cleanup(); }
  });
  it('waits for inline image insertion before allowing a page exit', async () => {
    let complete!: (value: unknown) => void;
    mediaHarness.upload.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    mediaHarness.files = [new File(['synthetic'], 'image.png', { type: 'image/png' })];
    const { editor, changes, cleanup } = mount('正文');
    editor.props.handlePaste(editor, { clipboardData: { getData: () => '' }, preventDefault() {} });
    const stale = { id: 'note:synthetic-editor', body: '旧内容', noteDocument: null as NoteDocument | null };
    expect(() => noteForClipboard(stale)).toThrow('图片正在添加');
    let allowed = false;
    const navigation = finishCanvasEditors().then(value => { allowed = value; });
    await Promise.resolve(); expect(allowed).toBe(false);
    complete({ id: 'b'.repeat(64) }); await navigation;
    expect(allowed).toBe(true);
    expect(changes.at(-1)?.document.content).toContainEqual({ type: 'image', assetId: 'b'.repeat(64), side: 'left', width: 60, placement:{xPercent:20,offsetY:0},wrap:'none' });
    expect(noteForClipboard(stale)).toMatchObject({ body: '正文', noteDocument: changes.at(-1)?.document });
    cleanup();
    expect(noteForClipboard(stale)).toBe(stale);
  });
  it('inserts each file at the text anchor in order across a partial upload and retry, with full-row layout', async () => {
    mediaHarness.files = ['a','b','c'].map(id => new File([id], id + '.png', {type:'image/png'}));
    const ids = ['a','b','c'].map(id => id.repeat(64));
    mediaHarness.upload.mockResolvedValueOnce({id:ids[0]}).mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValueOnce({id:ids[1]}).mockResolvedValueOnce({id:ids[2]});
    const {editor, changes, cleanup, render} = mount('前后');
    try {
      editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
      editor.props.handlePaste(editor, {clipboardData:{getData:()=>''},preventDefault(){}});
      expect(await finishCanvasEditors()).toBe(false);
      expect(pendingImageAction(render(),'retry')).toBe(true);
      expect(await finishCanvasEditors()).toBe(true);
      expect(changes.at(-1)?.document.content).toEqual([{type:'text',text:'前'},
        ...ids.map(assetId=>({type:'image',assetId,side:'left',width:60,placement:{xPercent:20,offsetY:0},wrap:'none'})),{type:'text',text:'后'}]);
    } finally { cleanup(); }
  });
  it('keeps a failed inline upload in its editor instead of silently leaving the page', async () => {
    mediaHarness.upload.mockRejectedValue(new Error('upload failed'));
    mediaHarness.files = [new File(['synthetic'], 'image.png', { type: 'image/png' })];
    const { editor, cleanup } = mount();
    editor.props.handlePaste(editor, { clipboardData: { getData: () => '' }, preventDefault() {} });
    expect(await finishCanvasEditors()).toBe(false);
    expect(() => noteForClipboard({ id: 'note:synthetic-editor', body: '' })).toThrow('待重试');
    expect(editor.destroyed).toBe(false); cleanup();
  });
  it('lets the author abandon only the failed remainder of a paste and then leave with the text and inserted image', async () => {
    mediaHarness.files = ['first.png', 'invalid.png'].map(name => new File(['synthetic'], name, { type: 'image/png' }));
    const insertedId = 'a'.repeat(64);
    mediaHarness.upload.mockResolvedValueOnce({ id: insertedId }).mockRejectedValueOnce(new Error('invalid image'));
    const { editor, changes, cleanup, render } = mount('已保存的文字');
    try {
      editor.props.handlePaste(editor, { clipboardData: { getData: () => '加一句' }, preventDefault() {} });
      expect(await finishCanvasEditors()).toBe(false);
      expect(pendingImageAction(render())).toBe(true);
      expect(await finishCanvasEditors()).toBe(true);
      expect(changes.at(-1)?.body).toContain('已保存的文字');
      expect(changes.at(-1)?.body).toContain('加一句');
      expect(changes.at(-1)?.document.content.filter(item => item.type === 'image')).toEqual([{ type: 'image', assetId: insertedId, side: 'left', width:60,placement:{xPercent:20,offsetY:0},wrap:'none' }]);
      expect(pendingImageAction(render())).toBe(false);
    } finally { cleanup(); }
  });
  it('blocks page exit during composition and flushes final DOM input before a safe exit', async () => {
    const { editor, changes, cleanup } = mount('初稿');
    editor.composing = true;
    expect(await finishCanvasEditors()).toBe(false);
    expect(editor.destroyed).toBe(false);
    editor.composing = false; editor.pending = editor.state.tr.insertText('，末尾。', 3);
    expect(await finishCanvasEditors()).toBe(true);
    expect(changes.at(-1)?.body).toBe('初稿，末尾。');
    expect(editor.destroyed).toBe(false);
    cleanup();
  });
  it('leaves Escape to the IME while composition is reported by the view or the Windows key code', () => {
    const { editor, onFinish, cleanup } = mount('原文');
    try {
      for (const [composing, keyCode] of [[true, 27], [false, 229]] as const) {
        editor.composing = composing;
        const event = { key: 'Escape', keyCode, isComposing: false, preventDefault: vi.fn(), stopPropagation: vi.fn() };
        expect(editor.props.handleDOMEvents.keydown(editor, event)).toBe(false);
        expect(event.preventDefault).not.toHaveBeenCalled(); expect(onFinish).not.toHaveBeenCalled();
      }
    } finally { cleanup(); }
  });
  it('flushes ordinary MutationObserver records even without the deferred timer', () => {
    const { editor, changes, cleanup } = mount();
    editor.scheduled = false; editor.pending = editor.state.tr.insertText('没开定时器，');
    editor.props.handleDOMEvents.blur(editor, { relatedTarget: null }); cleanup();
    expect(changes.map(change => change.body)).toEqual(['没开定时器，']);
    expect(harness.order.indexOf('flush')).toBeLessThan(harness.order.indexOf('finish'));
  });
  it('flushes deferred punctuation and Chinese input before ending editing', () => {
    const { editor, changes, onFinish, cleanup } = mount('原文');
    editor.pending = editor.state.tr.insertText('，中文！！  \n\n', 3);
    editor.props.handleDOMEvents.blur(editor, { relatedTarget: null });
    expect(changes.map(change => change.body)).toEqual(['原文，中文！！  \n\n']);
    expect(harness.order.indexOf('change')).toBeLessThan(harness.order.indexOf('finish'));
    expect(harness.order.indexOf('change')).toBeLessThan(harness.order.indexOf('composition:false'));
    cleanup();
    expect(changes).toHaveLength(1); expect(onFinish).toHaveBeenCalledTimes(1);
  });
  it('preserves the full document if selection unmounts before a blur event', () => {
    const { editor, changes, cleanup, onFinish } = mount();
    const doc: NoteDocument = { version: 1, content: [{ type: 'text', text: '你好。。\n  ' }, { type: 'image', assetId: 'a'.repeat(64), side: 'left', width: 50 }] };
    editor.pending = editor.state.tr.replaceWith(0, editor.state.doc.content.size, toEditor(doc).content);
    cleanup();
    expect(changes).toEqual([{ body: '你好。。\n  ', document: doc }]);
    expect(harness.order.indexOf('change')).toBeLessThan(harness.order.indexOf('destroy'));
    expect(onFinish).not.toHaveBeenCalled();
  });
  it('ends composition only after publishing pending mutations and ignores late callbacks after unmount', async () => {
    const { editor, changes, onComposition, cleanup } = mount();
    editor.props.handleDOMEvents.compositionstart();
    editor.pending = editor.state.tr.insertText('中文，');
    editor.props.handleDOMEvents.compositionend();
    expect(onComposition.mock.calls).toEqual([[true]]);
    await Promise.resolve();
    expect(changes[0]?.body).toBe('中文，');
    expect(onComposition.mock.calls).toEqual([[true], [false]]);
    editor.props.handleDOMEvents.compositionend(); cleanup();
    const calls = onComposition.mock.calls.length;
    await Promise.resolve(); expect(onComposition.mock.calls).toHaveLength(calls);
  });
  it('does not manufacture changes for an untouched blank or legacy note', () => {
    for (const body of ['', '旧文本  \n\n？？']) {
      harness.effects = []; harness.refCount = 0;
      const { editor, changes, cleanup } = mount(body);
      editor.props.handleDOMEvents.blur(editor, { relatedTarget: null }); cleanup();
      expect(changes).toEqual([]);
    }
  });
  it('publishes intentional repeated punctuation once per document, never deduplicates it', () => {
    const { editor, changes, cleanup } = mount();
    editor.dispatch(editor.state.tr.insertText('，，！！??'));
    editor.props.handleDOMEvents.blur(editor, { relatedTarget: null }); cleanup();
    expect(changes.map(change => change.body)).toEqual(['，，！！??']);
  });
  it('does not write an external document back during cleanup', () => {
    const { editor, changes, cleanup } = mount('旧内容');
    editor.dispatch(editor.state.tr.insertText('已保存的更改').setMeta('external', true));
    cleanup(); expect(changes).toEqual([]);
  });
  it('cleanup and fresh setup do not append or re-publish saved input', () => {
    const first = mount('中文，'); first.cleanup();
    harness.effects = []; harness.refCount = 0;
    const second = mount('中文，'); second.editor.pending = second.editor.state.tr.insertText('，', 4);
    second.cleanup();
    expect(first.changes).toEqual([]); expect(second.changes.map(change => change.body)).toEqual(['中文，，']);
  });
});
