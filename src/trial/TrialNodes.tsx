import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { MAX_TRIAL_NOTE_LENGTH, type TrialNote } from './model.js';

type ImageReader = (id: string) => Promise<Blob | undefined>;

export type TrialNode = Node<{
  note?: TrialNote;
  editing?: boolean;
  linking?: boolean;
  onEdit(id: string, body: string): void;
  onFinish(id: string): void;
  readImage: ImageReader;
}, 'trial'>;

function TrialImage({ id, readImage }: { id: string; readImage: ImageReader }) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let url = '';
    void readImage(id).then((blob) => {
      if (cancelled) return;
      if (!blob) { setFailed(true); return; }
      url = URL.createObjectURL(blob);
      setSource(url);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [id, readImage]);
  if (failed) return <span className="trial-image-error">图片暂不可读</span>;
  return source ? <img src={source} alt="便签图片" draggable={false} onError={() => setFailed(true)} /> : null;
}

export const TrialNodeCard = memo(function TrialNodeCard({ id, data, selected, width, height }: NodeProps<TrialNode>) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  // React Flow hides newly added nodes until their dimensions are measured.
  const readyToFocus = Boolean(width && height);
  useEffect(() => {
    if (!data.editing || !readyToFocus || !input.current) return;
    input.current.focus({ preventScroll: true });
    input.current.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [data.editing, readyToFocus]);
  const handles = <>
    <Handle className="trial-handle" type="target" position={Position.Left} />
    <Handle className="trial-handle" type="source" position={Position.Right} />
  </>;
  const nodeState = data.linking ? ' is-link-source' : selected ? ' is-selected' : '';
  const note = data.note;
  if (!note) return <article className={'trial-project' + nodeState}>
    {handles}
    <span className="trial-project__kicker">合成项目</span>
    <h2>春日书展</h2>
    <span className="trial-project__more">打开项目近况 <span aria-hidden="true">↗</span></span>
  </article>;

  return <article className={'trial-note' + nodeState} data-tone={note.tone}>
    {handles}
    {data.editing
      ? <textarea ref={input} className="nodrag nopan nowheel" aria-label="便签正文" placeholder="写下要记住的事……"
          value={note.body} maxLength={MAX_TRIAL_NOTE_LENGTH} rows={4}
          onChange={(event) => data.onEdit(id, event.target.value)}
          onBlur={() => data.onFinish(id)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Escape' && !event.nativeEvent.isComposing) event.currentTarget.blur();
          }} />
      : <p>{note.body || '空白便签'}</p>}
    {note.images.map((image) => <TrialImage key={image} id={image} readImage={data.readImage} />)}
  </article>;
});
