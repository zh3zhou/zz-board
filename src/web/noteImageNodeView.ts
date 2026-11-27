import type { Node as PMNode } from 'prosemirror-model';
import { NodeSelection, type EditorState } from 'prosemirror-state';
import type { EditorView, NodeView } from 'prosemirror-view';
import type { NoteImage } from '../shared/noteDocument.js';
import { mediaUrl } from './mediaClient.js';
import { openNoteImage } from './NoteDocumentView.js';
import { centeredImage, clamp, imageLayoutStyle, placedImage, resizedImage, type ImageLayout } from './noteImageLayout.js';

export function imageRecord(node: PMNode): NoteImage {
  const { assetId, side, width, placement, wrap } = node.attrs;
  return { type: 'image', assetId, side, width, ...(placement && { placement }), ...(wrap && { wrap }) };
}

/** Move this occurrence, even if the same media ID appears again in the same paragraph. */
export function relocateImage(state: EditorState, from: number, anchor: number, layout: ImageLayout) {
  const source = state.doc.nodeAt(from);
  if (source?.type.name !== 'image') return null;
  const tr = state.tr.delete(from, from + source.nodeSize);
  const at = tr.mapping.map(clamp(anchor, 1, state.doc.content.size - 1));
  tr.insert(at, source.type.create({ ...source.attrs, wrap: null, ...layout }));
  return tr.setSelection(NodeSelection.create(tr.doc, at));
}

function followPointer(event: PointerEvent, move: (event: PointerEvent) => void, finish: (commit: boolean) => void) {
  const element = event.currentTarget as HTMLElement;
  const id = event.pointerId;
  event.preventDefault();
  event.stopPropagation();
  element.setPointerCapture(id);
  const onMove = (next: PointerEvent) => { if (next.pointerId === id) move(next); };
  const onEnd = (next: PointerEvent) => {
    if (next.pointerId !== id) return;
    if (next.type === 'pointerup') move(next);
    cancel(next.type === 'pointerup');
  };
  function cancel(commit = false) {
    element.removeEventListener('pointermove', onMove);
    element.removeEventListener('pointerup', onEnd);
    element.removeEventListener('pointercancel', onEnd);
    element.removeEventListener('lostpointercapture', onEnd);
    if (element.hasPointerCapture(id)) element.releasePointerCapture(id);
    finish(commit);
  }
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onEnd);
  element.addEventListener('pointercancel', onEnd);
  element.addEventListener('lostpointercapture', onEnd);
  return cancel;
}

export function noteImageNodeView(initial: PMNode, editor: EditorView, getPos: () => number | undefined): NodeView {
  let node = initial, cancelGesture: (() => void) | undefined;
  const dom = document.createElement('span'), image = document.createElement('img'), controls = document.createElement('span');
  dom.className = 'note-image'; dom.contentEditable = 'false';
  controls.className = 'note-image-controls'; controls.dataset.exportExclude = 'true';
  image.alt = '便签图片'; image.draggable = false; dom.append(image, controls);
  function render(layout: ImageLayout = imageRecord(node)) {
    dom.removeAttribute('style');
    Object.assign(dom.style, imageLayoutStyle(layout));
    centerButton.setAttribute('aria-pressed', String(layout.wrap === 'none'));
    dom.classList.toggle('legacy-right', !layout.placement && layout.side === 'right');
    if (image.dataset.mediaId !== node.attrs.assetId) {
      image.src = mediaUrl(node.attrs.assetId);
      image.dataset.mediaId = node.attrs.assetId;
    }
    if (clip) positionControls();
  }
  const patch = (attrs: Record<string, unknown>) => {
    const pos = getPos();
    if (pos === undefined) return;
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
    editor.dispatch(tr.setSelection(NodeSelection.create(tr.doc, pos)));
  };
  const button = (title: string, text: string, action?: () => void) => {
    const item = document.createElement('button');
    item.type = 'button'; item.title = title; item.textContent = text; item.setAttribute('aria-label', title);
    item.onmousedown = event => event.preventDefault();
    if (action) item.onclick = action;
    controls.append(item);
    return item;
  };
  const moveButton = button('移动图片（可用方向键微调）', '✥');
  moveButton.className = 'note-image-move';
  button('靠左环绕', '←', () => patch({ side: 'left', placement: null, wrap: null }));
  const centerButton = button('居中独占一行', '↔', () => patch(centeredImage(node.attrs.width)));
  button('靠右环绕', '→', () => patch({ side: 'right', placement: null, wrap: null }));
  button('查看原图', '↗', () => openNoteImage(node.attrs.assetId, editor.dom));
  button('移除图片', '×', () => { const pos = getPos(); if (pos !== undefined) editor.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize)); });
  moveButton.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { width, side, placement } = imageRecord(node);
    const x = placement?.xPercent ?? (side === 'left' ? 0 : 100 - width);
    const y = placement?.offsetY ?? 0;
    const step = event.shiftKey ? 5 : 1;
    patch({ ...placedImage(width, x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
      y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0) * 4), wrap: null });
  };

  function drag(event: PointerEvent) {
    if (event.button !== 0 || cancelGesture || !dom.parentElement) return;
    const paragraph = dom.parentElement;
    const area = paragraph.getBoundingClientRect(), rect = image.getBoundingClientRect();
    if (!area.width || !rect.width) return;
    const scale = area.width / (paragraph.offsetWidth || area.width);
    const preview = image.cloneNode() as HTMLImageElement;
    preview.removeAttribute('data-media-id'); preview.alt = ''; preview.className = 'note-image-drag-preview';
    Object.assign(preview.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    document.body.append(preview);
    let x = rect.left, y = rect.top;
    cancelGesture = followPointer(event, next => {
      x = clamp(rect.left + next.clientX - event.clientX, area.left, area.right - rect.width);
      y = Math.max(area.top, rect.top + next.clientY - event.clientY);
      preview.style.left = x + 'px'; preview.style.top = y + 'px';
    }, commit => {
      cancelGesture = undefined; preview.remove();
      if (!commit || Math.abs(x - rect.left) + Math.abs(y - rect.top) < 2) return;
      const from = getPos();
      if (from === undefined) return;
      let anchor = from, dy = imageRecord(node).placement?.offsetY ?? 0;
      if (Math.abs(y - rect.top) >= 2) {
        // Hit-test the text as it would flow without this occurrence. Holding the
        // paragraph height keeps scroll position stable while measuring the anchor.
        const minHeight = paragraph.style.minHeight;
        paragraph.style.minHeight = paragraph.offsetHeight + 'px';
        dom.style.display = 'none';
        try {
          const hit = editor.posAtCoords({ left: area.left + 1, top: y + 1 });
          anchor = clamp(hit?.pos ?? editor.state.doc.content.size - 1, 1, editor.state.doc.content.size - 1);
          dy = Math.max(0, (y - editor.coordsAtPos(anchor).top) / scale);
        } finally { dom.style.removeProperty('display'); paragraph.style.minHeight = minHeight; }
      }
      const layout = placedImage(node.attrs.width, (x - area.left) / area.width * 100, dy);
      const tr = relocateImage(editor.state, from, anchor, layout);
      if (tr) editor.dispatch(tr);
    });
  }
  moveButton.onpointerdown = drag;
  image.onpointerdown = event => { if (dom.classList.contains('is-selected')) drag(event); };

  const resize = button('等比例缩放图片（左右键可微调）', '⌟');
  resize.className = 'note-image-resize'; resize.dataset.exportExclude = 'true'; dom.append(resize);
  resize.onkeydown = event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault(); event.stopPropagation();
    const layout = imageRecord(node), step = event.shiftKey ? 5 : 1;
    patch(resizedImage(layout, layout.width + (event.key === 'ArrowRight' ? step : -step)));
  };
  resize.onpointerdown = event => {
    if (event.button !== 0 || cancelGesture) return;
    const original = imageRecord(node);
    const available = dom.parentElement?.getBoundingClientRect().width;
    if (!available) return;
    const factor = original.wrap === 'none' ? 2 : !original.placement && original.side === 'right' ? -1 : 1;
    let layout: ImageLayout = original;
    cancelGesture = followPointer(event, next => {
      layout = resizedImage(original, Math.round(original.width + factor * (next.clientX - event.clientX) / available * 100));
      render(layout);
    }, commit => { cancelGesture = undefined; render(); if (commit && layout.width !== original.width) patch(layout); });
  };
  let clip: HTMLElement | null = null, observer: ResizeObserver | null = null;
  function positionControls() {
    const paragraph = dom.parentElement;
    if (!clip || !paragraph) return;
    // The paragraph is the image's offset parent. These coordinates stay in paper units at any zoom.
    controls.style.maxWidth = paragraph.clientWidth + 'px';
    const width = controls.offsetWidth, height = controls.offsetHeight;
    const left = clamp(dom.offsetLeft + (dom.offsetWidth - width) / 2, 0, paragraph.clientWidth - width);
    controls.style.left = (left - dom.offsetLeft) + 'px';
    if (dom.offsetHeight >= height + resize.offsetHeight + 4) {
      controls.style.top = '0';
    } else {
      // A short image needs its buttons outside the photo so its corner handle remains reachable.
      const photo = dom.getBoundingClientRect(), bounds = clip.getBoundingClientRect();
      controls.style.top = photo.top - bounds.top > bounds.bottom - photo.bottom ? -(height + 2) + 'px' : 'calc(100% + 2px)';
    }
  }
  function selectImage() {
    dom.classList.add('is-selected');
    if (observer || !dom.parentElement) return;
    clip = dom.closest('.note-scroll-viewport, .focused-note-body') ?? editor.dom;
    observer = new ResizeObserver(positionControls);
    for (const element of [clip, dom.parentElement, dom]) observer.observe(element);
    clip.addEventListener('scroll', positionControls, { passive: true });
    positionControls();
  }
  function deselectImage() {
    dom.classList.remove('is-selected');
    clip?.removeEventListener('scroll', positionControls);
    observer?.disconnect(); observer = null; clip = null;
  }
  render();
  return { dom,
    update(next) { if (next.type !== node.type) return false; node = next; render(); return true; },
    selectNode: selectImage, deselectNode: deselectImage,
    stopEvent(event) { return (event.target as Element).closest('button') !== null; },
    ignoreMutation: () => true, destroy() { deselectImage(); cancelGesture?.(); }
  };
}
