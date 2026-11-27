import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { history, redo, undo } from 'prosemirror-history';
import { documentText, noteDocumentSchema, textDocument, type NoteDocument } from '../shared/noteDocument.js';
import { clipboardImages, mediaUrl, uploadImage, type ClipboardImage } from './mediaClient.js';
import { imageRecord, noteImageNodeView } from './noteImageNodeView.js';
import { centeredImage, imageLayoutStyle } from './noteImageLayout.js';
import './noteDocument.css';
import { registerEditorExit, registerNoteClipboardReader } from './editorNavigation.js';

const schema = new Schema({ nodes: {
  doc: { content: 'paragraph' }, paragraph: { content: '(text|image)*', whitespace: 'pre', toDOM: () => ['div', { class: 'note-document' }, 0] },
  text: {}, image: { inline: true, atom: true, selectable: true, attrs: { assetId: {}, side: { default: 'right' }, width: { default: 45 }, placement: { default: null }, wrap: { default: null } },
    toDOM: node => {
      const dom = document.createElement('span'), img = document.createElement('img');
      dom.className = 'note-image'; Object.assign(dom.style, imageLayoutStyle(imageRecord(node)));
      img.src = mediaUrl(node.attrs.assetId); img.dataset.mediaId = node.attrs.assetId; img.alt = '便签图片'; dom.append(img);
      return dom;
    } }
} });
export function toEditor(doc: NoteDocument): PMNode {
  return schema.node('doc', null, [schema.node('paragraph', null, doc.content.flatMap(item => item.type === 'text' ? item.text ? [schema.text(item.text)] : [] : [schema.node('image', item)]))]);
}
export function fromEditor(doc: PMNode): NoteDocument {
  const content: NoteDocument['content'] = [];
  doc.firstChild?.forEach(node => { if (node.isText) content.push({ type: 'text', text: node.text! }); else if (node.type.name === 'image') content.push(imageRecord(node)); });
  return noteDocumentSchema.parse({ version: 1, content });
}
const fragmentType = 'application/x-zz-board-fragment';
const clipboardWindow = crypto.randomUUID();
function copyFragment(editor: EditorView, event: ClipboardEvent, dataStoreId?: string) {
  const { doc, selection } = editor.state, paragraph = doc.firstChild;
  if (!event.clipboardData || !paragraph || selection.empty) return false;
  const selected = paragraph.cut(Math.max(0, selection.from - 1), Math.min(paragraph.content.size, selection.to - 1));
  const value = fromEditor(schema.node('doc', null, [selected]));
  if (!value.content.some(item => item.type === 'image')) return false;
  try {
    event.clipboardData.setData(fragmentType, JSON.stringify({ window: clipboardWindow, store: dataStoreId ?? null, document: value }));
    event.clipboardData.setData('text/plain', documentText(value));
  } catch { return false; }
  event.preventDefault();
  if (event.type === 'cut') editor.dispatch(editor.state.tr.deleteSelection().scrollIntoView());
  return true;
}
function pastedFragment(data: DataTransfer | null, dataStoreId?: string) {
  const raw = data?.getData(fragmentType);
  if (!raw || raw.length > 196608) return null;
  try {
    const value = JSON.parse(raw);
    const sameStore = dataStoreId ? value?.store === dataStoreId : value?.store == null && value?.window === clipboardWindow;
    if (sameStore) return noteDocumentSchema.parse(value.document);
  } catch { /* Other applications can supply arbitrary clipboard data. */ }
  return null;
}
export interface NoteRichEditorProps {
  body: string; document?: NoteDocument | null; online: boolean; autoFocus?: boolean; initialPoint?: { x: number; y: number }; label?: string; dataStoreId?: string; noteId?: string;
  onChange(body: string, document: NoteDocument): void; onFinish(): void; onComposition(active: boolean): void; onNotice?(text: string): void;
}
export default function NoteRichEditor(props: NoteRichEditorProps) {
  const host = useRef<HTMLDivElement>(null), view = useRef<EditorView | null>(null), callbacks = useRef(props);
  callbacks.current = props;
  const [uploading, setUploading] = useState(false), [failedFiles, setFailedFiles] = useState<ClipboardImage[]>([]);
  const uploadRef = useRef<(files: ClipboardImage[]) => void>(() => {});
  const failedFilesRef = useRef<ClipboardImage[]>([]);
  failedFilesRef.current = failedFiles;
  useLayoutEffect(() => {
    if (!host.current) return;
    let alive = true, uploadingNow = false;
    let uploadDone: Promise<void> | null = null;
    const rememberFailed = (files: ClipboardImage[]) => { failedFilesRef.current = [...new Set([...failedFilesRef.current, ...files])]; setFailedFiles(failedFilesRef.current); };
    let insertion: number | null = null;
    let published = toEditor(props.document ?? textDocument(props.body));
    function publishInput() {
      if (published.eq(editor.state.doc)) return;
      published = editor.state.doc;
      const doc = fromEditor(published);
      callbacks.current.onChange(documentText(doc), doc);
    }
    function flushInput() {
      // PM 1.42 defers some DOM mutations by 20ms. Finish/selection can unmount
      // the editor before that timer. Keep this compatibility seam isolated and
      // covered by lifecycle tests; never deduplicate the user's actual text.
      const observer = (editor as EditorView & { domObserver: { forceFlush(): void; flush(): void } }).domObserver;
      observer.forceFlush();
      observer.flush();
      publishInput();
    }
    const editor = new EditorView(host.current, {
      state: EditorState.create({ schema, doc: toEditor(props.document ?? textDocument(props.body)), plugins: [
        history(), keymap({ 'Mod-z': (state, dispatch) => { undo(state, dispatch); return true; }, 'Mod-y': (state, dispatch) => { redo(state, dispatch); return true; }, 'Mod-Shift-z': (state, dispatch) => { redo(state, dispatch); return true; }, Enter: (state, dispatch) => { dispatch?.(state.tr.insertText('\n')); return true; }, 'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.insertText('\n')); return true; } }),
        keymap(baseKeymap), new Plugin({ filterTransaction(tr) { if (!tr.docChanged) return true; try { fromEditor(tr.doc); return true; } catch { callbacks.current.onNotice?.('便签最多 20000 字符、16 张图片。'); return false; } } })
      ] }),
      nodeViews: { image: noteImageNodeView }, attributes: { class: 'note-rich-editor nodrag nowheel', role: 'textbox', 'aria-label': props.label || '便签内容', 'aria-multiline': 'true' },
      dispatchTransaction(tr) {
        const state = editor.state.apply(tr);
        if (state === editor.state) return;
        if (insertion !== null) insertion = tr.mapping.map(insertion);
        editor.updateState(state);
        if (tr.getMeta('external')) published = state.doc;
        else if (tr.docChanged) publishInput();
      },
      handlePaste(_editor, event) {
        const fragment = pastedFragment(event.clipboardData, callbacks.current.dataStoreId);
        if (fragment) {
          event.preventDefault();
          const { from, to } = editor.state.selection;
          editor.dispatch(editor.state.tr.replaceWith(from, to, toEditor(fragment).firstChild!.content).scrollIntoView());
          return true;
        }
        const files = clipboardImages(event.clipboardData);
        const text = event.clipboardData?.getData('text/plain');
        if (files.length) { event.preventDefault(); if (text) editor.dispatch(editor.state.tr.insertText(text)); uploadRef.current(files); return true; }
        if (text !== undefined) { event.preventDefault(); editor.dispatch(editor.state.tr.insertText(text)); return true; } return false;
      },
      handleDOMEvents: {
        copy: (view, event) => copyFragment(view, event, callbacks.current.dataStoreId),
        cut: (view, event) => copyFragment(view, event, callbacks.current.dataStoreId),
        compositionstart() { callbacks.current.onComposition(true); return false; },
        compositionend() { queueMicrotask(() => { if (alive) { flushInput(); callbacks.current.onComposition(false); } }); return false; },
        blur(_view, event) { if (host.current?.contains((event as FocusEvent).relatedTarget as Node)) return false; flushInput(); callbacks.current.onComposition(false); if (!uploadingNow && !failedFilesRef.current.length) callbacks.current.onFinish(); return false; },
        keydown(view, event) {
          if (view.composing || event.isComposing || event.keyCode === 229) return false;
          if (event.key === 'Escape' || event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); editor.dom.blur(); return true; } return false;
        }
      }
    });
    async function insert(files: ClipboardImage[]) {
      if (!callbacks.current.online) { callbacks.current.onNotice?.('当前离线，恢复连接后再粘贴图片；文字可以继续编辑。'); return; }
      if (uploadingNow) { rememberFailed(files); callbacks.current.onNotice?.('正在添加图片；这次粘贴已保留，请稍后点“重试添加”。'); return; }
      uploadingNow = true; setUploading(true); failedFilesRef.current = failedFilesRef.current.filter(file => !files.includes(file)); setFailedFiles(failedFilesRef.current); insertion = editor.state.selection.from;
      const remaining = [...files];
      try {
        while (remaining.length && alive) {
          if (fromEditor(editor.state.doc).content.filter(item => item.type === 'image').length >= 16) throw new Error('每张便签最多 16 张图片。');
          const asset = await uploadImage(remaining[0]!);
          if (!alive) { callbacks.current.onNotice?.('已结束这张便签的编辑，图片尚未插入；请回到便签重新粘贴。文字已保留。'); break; }
          const pos = Math.min(insertion ?? editor.state.selection.from, editor.state.doc.content.size - 1);
          editor.dispatch(editor.state.tr.insert(pos, schema.node('image', { assetId: asset.id, ...centeredImage() })));
          remaining.shift();
        }
      } catch (error) { if (alive) { rememberFailed(remaining); callbacks.current.onNotice?.(error instanceof Error ? error.message : '图片未能保存。'); } }
      finally { uploadingNow = false; insertion = null; if (alive) { setUploading(false); if (!editor.hasFocus() && !failedFilesRef.current.length) callbacks.current.onFinish(); } }
    }
    const startUpload = (files: ClipboardImage[]) => { if (uploadingNow) { rememberFailed(files); return; } const task = insert(files); uploadDone = task; void task.finally(() => { if (uploadDone === task) uploadDone = null; }); };
    uploadRef.current = startUpload;
    const unregisterExit = registerEditorExit(async () => {
      if (editor.composing) { callbacks.current.onNotice?.('请先完成当前中文组字，再切换页面。'); return false; }
      if (uploadDone) await uploadDone;
      if (!alive) return true;
      if (failedFilesRef.current.length) { callbacks.current.onNotice?.('便签仍有图片待重试，请先添加完成或保留当前编辑。'); return false; }
      flushInput();
      return true;
    });
    const unregisterClipboard = registerNoteClipboardReader(props.noteId, () => {
      if (editor.composing) throw new Error('请先完成当前中文组字，再复制或保存便签图片。');
      if (uploadingNow || failedFilesRef.current.length) throw new Error('便签上还有图片正在添加或待重试，请先处理后再复制或导出。');
      flushInput();
      const doc = fromEditor(editor.state.doc);
      return { body: documentText(doc), noteDocument: doc };
    });
    view.current = editor;
    if (props.autoFocus) {
      const point = props.initialPoint && editor.posAtCoords({ left: props.initialPoint.x, top: props.initialPoint.y });
      if (point) editor.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(point.pos))));
      editor.focus();
    }
    return () => { unregisterExit(); unregisterClipboard(); flushInput(); alive = false; editor.destroy(); view.current = null; callbacks.current.onComposition(false); };
  }, []);
  useEffect(() => {
    const editor = view.current; if (!editor || editor.hasFocus() || editor.composing) return;
    const value = props.document ?? textDocument(props.body);
    if (JSON.stringify(fromEditor(editor.state.doc)) !== JSON.stringify(value)) editor.dispatch(editor.state.tr.replaceWith(0, editor.state.doc.content.size, toEditor(value).content).setMeta('addToHistory', false).setMeta('external', true));
  }, [props.body, props.document]);
  return <div className="note-editor-host nodrag nowheel" onPointerDown={event => event.stopPropagation()}>
    <div ref={host} />{uploading && <small role="status" data-export-exclude>正在添加图片…</small>}{failedFiles.length > 0 && <div data-export-exclude>
      <button type="button" disabled={uploading} onClick={() => uploadRef.current(failedFiles)}>重试添加 {failedFiles.length} 张图片</button>
      <button type="button" disabled={uploading} onClick={() => {
        failedFilesRef.current = []; setFailedFiles([]);
        callbacks.current.onNotice?.('');
        if (!view.current?.hasFocus()) callbacks.current.onFinish();
      }}>放弃待添加图片</button>
    </div>}
  </div>;
}
