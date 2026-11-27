import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NoteDocument } from '../shared/noteDocument.js';
import { mediaUrl } from './mediaClient.js';
import { imageLayoutStyle } from './noteImageLayout.js';
import './noteDocument.css';

export function openNoteImage(id: string, source?: HTMLElement) {
  (source ?? window).dispatchEvent(new CustomEvent('zz-open-image', { detail: id, bubbles: true }));
}
export function NoteImageView({ id, original = false, detail = false }: { id: string; original?: boolean; detail?: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  const [visible, setVisible] = useState(false);
  const [failedOriginal, setFailedOriginal] = useState<string | null>(null);
  useEffect(() => {
    if (original) return; // Export loads originals sequentially, not during render.
    if (!ref.current) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: '400px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [original]);
  return <img ref={ref} src={!original && visible ? mediaUrl(id, detail && failedOriginal !== id) : undefined} data-media-id={id} alt="便签图片" decoding="async"
    onError={() => { if (detail) setFailedOriginal(id); }}
    onDoubleClick={event => { event.stopPropagation(); openNoteImage(id, event.currentTarget); }} />;
}
export function NoteDocumentView({ body, document, original = false }: { body: string; document?: NoteDocument | null; original?: boolean }) {
  return <div className="note-document note-copy">{document ? document.content.map((item, index) => item.type === 'text' ? item.text :
    <span key={index} className="note-image" style={imageLayoutStyle(item)}><NoteImageView id={item.assetId} original={original} /></span>) : body}</div>;
}
export function ImageViewer() {
  const [image, setImage] = useState<{ id: string; returnTo: HTMLElement | null } | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent).detail;
      if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) return;
      const source = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[contenteditable="true"],button,[tabindex]') : null;
      const active = document.activeElement;
      setImage({ id, returnTo: source ?? (active instanceof HTMLElement ? active : null) });
    };
    window.addEventListener('zz-open-image', open); return () => window.removeEventListener('zz-open-image', open);
  }, []);
  function close() {
    setImage(null);
    if (image?.returnTo?.isConnected) image.returnTo.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (!image) return;
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' && event.key !== 'Tab') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') close();
      else closeButton.current?.focus({ preventScroll: true });
    };
    const paste = (event: ClipboardEvent) => { event.preventDefault(); event.stopImmediatePropagation(); };
    const capture = { capture: true };
    window.addEventListener('keydown', keyDown, capture);
    window.addEventListener('paste', paste, capture);
    return () => { window.removeEventListener('keydown', keyDown, capture); window.removeEventListener('paste', paste, capture); };
  }, [image]);
  return image ? <div className="image-viewer" role="dialog" aria-modal="true" aria-label="查看原图" onClick={close} onKeyDown={event => event.stopPropagation()} tabIndex={-1}>
    <button ref={closeButton} autoFocus className="panel-close" aria-label="关闭原图">×</button>
    <img src={mediaUrl(image.id, true)} alt="原图" onClick={event => event.stopPropagation()} />
  </div> : null;
}
