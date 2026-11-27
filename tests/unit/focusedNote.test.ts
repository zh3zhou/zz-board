import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canvasNodeSchema } from '../../src/shared/schema.js';
import { NoteScheduleForm } from '../../src/web/NoteScheduleForm.js';
import { FocusedNote } from '../../src/web/FocusedNote.js';
import { NoteEditor } from '../../src/web/NoteEditor.js';
import { ImageViewer, NoteDocumentView, NoteImageView, openNoteImage } from '../../src/web/NoteDocumentView.js';
import { registerEditorExit } from '../../src/web/editorNavigation.js';
import type { NoteEdit } from '../../src/web/noteAutosave.js';

const hooks = vi.hoisted(() => ({ state: [] as any[], index: 0, effects: [] as Array<() => void | (() => void)>, layouts: [] as Array<() => void | (() => void)> }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.state)) hooks.state[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.state[index], (value: any) => { hooks.state[index] = typeof value === 'function' ? value(hooks.state[index]) : value; }];
  },
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
  useLayoutEffect: (effect: () => void | (() => void)) => { hooks.layouts.push(effect); }
}));

const image = { type: 'image', assetId: 'a'.repeat(64), side: 'left', width: 45 } as const;
const note = canvasNodeSchema.parse({ kind: 'note', id: 'note:synthetic', threadKey: null, title: '', body: '中文\n末段',
  noteDocument: { version: 1, content: [{ type: 'text', text: '中文\n' }, image, { type: 'text', text: '末段' }] },
  x: 10, y: 20, width: 200, height: 140, zIndex: 1, revision: 2, lastViewedAt: null, createdAt: '', updatedAt: '' });
const anchor = { getBoundingClientRect: () => ({ left: 100, top: 120, width: 200, height: 140 }) } as HTMLElement;
function elements(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function mount(patch: Partial<Parameters<typeof FocusedNote>[0]> = {}) {
  const props = { note, anchor, online: true, readOnly: false, details: vi.fn(() => createElement('aside')), onChange: vi.fn(),
    onComposition: vi.fn(), onSave: vi.fn(), onClose: vi.fn(async () => {}), ...patch };
  function render() { hooks.index = 0; return elements(FocusedNote(props)); }
  return { props, render };
}
beforeEach(() => { hooks.state = []; hooks.index = 0; hooks.effects = []; hooks.layouts = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('focus an existing note without changing its canvas geometry', () => {
  it('starts in the complete editable document and mounts additional information only when opened', () => {
    const { props, render } = mount();
    const first = render();
    const editor = first.find(item => item.type === NoteEditor)!;
    expect(editor.props.autoFocus).toBe(true);
    expect(editor.props.document).toBe(note.noteDocument); expect(editor.props.body).toBe('中文\n末段');
    expect(props.details).not.toHaveBeenCalled(); expect(props.onChange).not.toHaveBeenCalled();
    first.find(item => item.type === 'button' && item.props['aria-label'] === '详情')!.props.onClick();
    const second = render();
    expect(props.details).toHaveBeenCalledOnce();
    expect(second.filter(item => item.type === NoteEditor)).toHaveLength(1);
    const document = { version: 1, content: [{ type: 'text', text: '中文\n只改末句' }, image] };
    second.find(item => item.type === NoteEditor)!.props.onChange('中文\n只改末句', document);
    expect(props.onChange).toHaveBeenCalledExactlyOnceWith('中文\n只改末句', document);
    expect([note.x, note.y, note.width, note.height]).toEqual([10, 20, 200, 140]);
  });
  it('keeps offline text editable and archived pages and standalone images readable', () => {
    expect(mount({ online: false }).render().find(item => item.type === NoteEditor)?.props.online).toBe(false);
    expect(mount({ readOnly: true }).render().some(item => item.type === NoteEditor)).toBe(false);
    expect(mount({ readOnly: true }).render().find(item => item.type === NoteDocumentView)?.props.document).toBe(note.noteDocument);
    const imageNote = mount({ note: { ...note, notePresentation: 'image' } }).render();
    expect(imageNote.find(item => item.type === NoteImageView)?.props).toMatchObject({ id: image.assetId, detail: true });
  });
  it('opens arrangement by button, closes only that panel on Escape, and disables it on archived or offline notes', async () => {
    const patch = { priorityDate: '2028-03-01', onSaveArrangement: vi.fn() };
    const { props, render } = mount(patch);
    const button = () => render().find(item => item.type === 'button' && item.props['aria-label'] === '安排 · 未设优先级')!;
    expect(button().props.disabled).toBe(false);
    await button().props.onClick();
    const arranged = render();
    expect(arranged.find(item => item.type === NoteScheduleForm)?.props.note).toBe(note);
    expect(arranged.find(item => item.type === NoteEditor)?.props.autoFocus).toBe(false);
    arranged[0]!.props.onKeyDownCapture({ key:'Escape', nativeEvent:{}, preventDefault:vi.fn(), stopPropagation:vi.fn() });
    expect(render().some(item => item.type === NoteScheduleForm)).toBe(false);
    expect(props.onClose).not.toHaveBeenCalled();
    for (const mode of [{readOnly:true},{online:false}]) {
      const disabled = mount({...patch,...mode}).render().find(item => item.type === 'button' && item.props['aria-label'] === '安排 · 未设优先级');
      expect(disabled?.props.disabled).toBe(true);
    }
  });

  it('keeps routine save progress out of the paper, exposes failures, and announces the current priority from the outside toolbar', () => {
    const edit: NoteEdit = { record: note, body: note.body, status: 'pending', sequence: 3, savedSequence: 2, sessionId: 'synthetic' };
    const options = { note: { ...note, manualPriority: 'p1' as const }, priorityDate: '2028-03-01', onSaveArrangement: vi.fn() };
    for (const status of ['pending', 'saving'] as const) {
      const tree = mount({ ...options, edit: { ...edit, status } }).render();
      expect(tree.some(item => item.props.className === 'focused-note-status' || item.type === 'h2')).toBe(false);
      const paper = tree.find(item => item.props.className === 'focused-note-paper');
      expect(elements(paper).some(item => item.props['aria-label'] === '便签操作')).toBe(false);
      expect(tree.some(item => item.props['aria-label'] === '安排 · 优先')).toBe(true);
    }
    const failure = mount({ ...options, edit: { ...edit, status: 'error', error: '保存失败，草稿保留。' } }).render();
    expect(failure.find(item => item.props.className === 'focused-note-status')?.props.children).toBe('保存失败，草稿保留。');
  });

  it('keeps a changed schedule editable after a failed save and sends both thresholds together', async () => {
    const original = { ...note, manualPriority: 'p3' as const };
    const onSave = vi.fn().mockRejectedValueOnce(new Error('请核对')).mockResolvedValue(undefined);
    const props = { note: original, today: '2028-02-25', disabled: false, onClose: vi.fn(), onBusy: vi.fn(), onSave };
    const render = () => { hooks.index = 0; return elements(NoteScheduleForm(props)); };
    const input = (type: string, index = 0) => render().filter(item => item.type === 'input' && item.props.type === type)[index]!;
    const set = (type: string, value: string, index = 0) => input(type, index).props.onChange({target:{value}});
    const save = () => render()[0]!.props.onSubmit({preventDefault:vi.fn()});
    set('date', '2028-03-01'); set('number', '1'); set('number', '3', 1);
    await save(); expect(onSave).not.toHaveBeenCalled();
    set('number', '14'); await save();
    expect(render().find(item => item.props.role === 'alert')?.props.children).toBe('请核对');
    expect(input('date').props.value).toBe('2028-03-01'); expect(props.onClose).not.toHaveBeenCalled();
    await save();
    expect(onSave).toHaveBeenLastCalledWith(original, 'p3', {dueDate:'2028-03-01',autoPromote:true,attentionDays:14,priorityDays:3,completed:false});
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('focuses the writable textbox or the read-only scroll area and keeps Tab inside a read-only note', () => {
    const textbox = { focus: vi.fn() }, region = { querySelector: vi.fn(), focus: vi.fn() };
    const first = { getClientRects: () => [1], focus: vi.fn() }, last = { ...first, focus: vi.fn() };
    const doc = { activeElement: null as unknown };
    vi.stubGlobal('document', doc);
    for (const readOnly of [false, true]) {
      hooks.layouts = [];
      const tree = mount({ readOnly }).render();
      tree.find(item => item.props['aria-label'] === '便签正文')!.props.ref.current = region;
      region.querySelector.mockReturnValue(readOnly ? null : textbox);
      for (const setup of hooks.layouts) setup();
      if (!readOnly) { expect(textbox.focus).toHaveBeenCalledWith({ preventScroll: true }); continue; }
      expect(region.focus).toHaveBeenCalledWith({ preventScroll: true });
      doc.activeElement = region;
      for (const shiftKey of [false, true]) {
        const event = { nativeEvent: {}, key: 'Tab', shiftKey, preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => [first, last] } };
        tree[0]!.props.onKeyDownCapture(event);
        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(shiftKey ? last.focus : first.focus).toHaveBeenCalledOnce();
      }
    }
  });
  it('lets the original image own Tab, Escape and paste, then returns focus to the note', () => {
    const target = new EventTarget();
    class Focusable {
      isConnected = true;
      focus = vi.fn();
    }
    const opener = new Focusable(), closeButton = new Focusable();
    vi.stubGlobal('window', target); vi.stubGlobal('HTMLElement', Focusable);
    vi.stubGlobal('document', { activeElement: opener });
    expect(ImageViewer()).toBe(null);
    const stopListening = hooks.effects[0]!();
    openNoteImage(image.assetId);
    hooks.index = 0; hooks.layouts = [];
    const tree = elements(ImageViewer());
    const button = tree.find(item => item.props['aria-label'] === '关闭原图')!;
    button.props.ref.current = closeButton;
    expect(button.props.autoFocus).toBe(true);
    const stopTrapping = hooks.layouts[0]!();
    const canvasPaste = vi.fn(); target.addEventListener('paste', canvasPaste);
    try {
      const paste = new Event('paste', { cancelable: true });
      expect(target.dispatchEvent(paste)).toBe(false); expect(canvasPaste).not.toHaveBeenCalled();
      const key = (value: string) => Object.assign(new Event('keydown', { cancelable: true }), { key: value });
      expect(target.dispatchEvent(key('Tab'))).toBe(false); expect(closeButton.focus).toHaveBeenCalledOnce();
      expect(target.dispatchEvent(key('Escape'))).toBe(false);
      expect(opener.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
      hooks.index = 0; expect(ImageViewer()).toBe(null);
    } finally { stopTrapping?.(); stopListening?.(); }
    target.dispatchEvent(new Event('paste')); expect(canvasPaste).toHaveBeenCalledOnce();
  });
  it('leaves composing Escape to the IME and waits for pending editor work before closing', async () => {
    const { props, render } = mount();
    const tree = render();
    const composing = { key: 'Escape', nativeEvent: { isComposing: true }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree[0]!.props.onKeyDownCapture(composing);
    expect(composing.preventDefault).not.toHaveBeenCalled(); expect(props.onClose).not.toHaveBeenCalled();
    const editor = tree.find(item => item.type === NoteEditor)!;
    editor.props.onComposition(true);
    tree[0]!.props.onKeyDownCapture({ ...composing, nativeEvent: { isComposing: false, keyCode: 27 } });
    expect(composing.preventDefault).not.toHaveBeenCalled();
    editor.props.onComposition(false);
    let resolve!: (value: boolean) => void;
    const gate = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const unregister = registerEditorExit(gate);
    try {
      const close = tree.find(item => item.props['aria-label'] === '收起便签')!.props.onClick;
      close(); close(); expect(gate).toHaveBeenCalledTimes(1); expect(props.onClose).not.toHaveBeenCalled();
      resolve(false); await vi.waitFor(() => { close(); expect(gate).toHaveBeenCalledTimes(2); });
      expect(props.onClose).not.toHaveBeenCalled(); resolve(true);
      await vi.waitFor(() => expect(props.onClose).toHaveBeenCalledOnce());
    } finally { unregister(); }
  });
});
