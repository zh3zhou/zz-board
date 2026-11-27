import { useState } from 'react';
import type { EffectivePriority } from '../shared/notePriority.js';
import { defaultPriorityIcons, type PriorityIcons } from '../shared/priorityIcons.js';
import { api } from './api.js';
import { mediaUrl, uploadImage } from './mediaClient.js';

/** The two poses stay distinct at toolbar size and in monochrome. */
export function PriorityIcon({ level, icons = defaultPriorityIcons }: { level: EffectivePriority; icons?: PriorityIcons }) {
  const high = level === 'p1';
  const asset = high ? icons.highImage : icons.attentionImage;
  if (level && icons.style === 'custom' && asset) return <img className="priority-glyph" src={mediaUrl(asset)} alt="" />;
  if (!level) return <svg className="priority-glyph" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <path d="M9 26V6h15l-3.5 5 3.5 5H9" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" /></svg>;
  const ink = icons.style !== 'ginger-cat';
  const fur = ink ? '#252824' : '#d58a53', outline = ink ? '#686f59' : '#603b2b';
  return <svg className="priority-glyph" viewBox="0 0 32 32" aria-hidden="true">
    <g fill={fur} stroke={outline} strokeWidth="1.15" strokeLinejoin="round" strokeLinecap="round">
      {high ? <>
        <path d={ink ? 'M17 12q6-1 8-5 1-2 2-1 3 5-5 9l-3 2 4 4q1 2-1 3l-6-5-4-1-4 3-5-1q-2-1 0-2l4-1 3-5z'
          : 'M11 15q5-7 11-3l3 1q2-1 1-5-1-3 1-3 4 3 3 8-1 5-6 5l2 4 3 2q1 3-2 2l-6-3-3-5-5 2-6-1-4 2-2-1 4-5z'} />
        <path d={ink ? 'm6 8-1-6 5 3q2-1 5 0l4-4 .4 6q3 3 1.2 7-2 4-7.1 5-5 1-8-2-4-4 .5-9z'
          : 'M5 10 3 2l7 3 5 .2 5-4-.4 8 1.4 4-5 4-6-.5-5-4.5z'} />
      </> : <>
        <path d={ink ? 'M11 18q-2 4 0 8h-1q-2 2 1 2h3l1-4h1l1 4h3q2 0 .5-2H20q2-3 1-6 7 1 7-6 0-2-2-1-1 6-7 4z'
          : 'm12 16-1 7-3 4q-1 2 2 2h12q2 0 2-2l-2-3q8-2 6-10-1-3-2-2-.4 5-5 6l-2-3z'} />
        <path d={ink ? 'm6 11 .5-8 5 4q4-1 7 0l5-4 .2 8q2 4-.5 7-2 3-8 3t-8.5-3q-2-3-.2-7z'
          : 'M6 11 5 2l7 5 5 .2 6-5-.5 9 2 2-2 4-7 4-6-2.8L5 15z'} />
      </>}
    </g>
    <g transform={high ? 'translate(-1 -2) rotate(-10 13 12)' : undefined}>
      <ellipse cx="11.1" cy="13.2" rx={ink ? 3.1 : 2.3} ry={high ? 3.45 : 2.9} fill={ink ? '#f2e9be' : '#fff2d5'} />
      <ellipse cx="18.2" cy="13.2" rx={ink ? 3.1 : 2.3} ry={high ? 3.45 : 2.9} fill={ink ? '#f2e9be' : '#fff2d5'} />
      <g fill="#282724"><ellipse cx="11.6" cy="13" rx=".95" ry={high ? 1.05 : 1.8} /><ellipse cx="18.7" cy="13" rx=".95" ry={high ? 1.05 : 1.8} /></g>
      {!ink && <path d="m12 8 .8 2m2-2.2.3 2m2-2.1-.6 2" stroke="#7e4a2d" strokeWidth="1.3" strokeLinecap="round" />}
    </g>
    {high && <path d="m7 24-2 3m6-2-1 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
  </svg>;
}

export function NoteActionIcon({ kind }: { kind: 'details' | 'close' | 'copy' | 'focus' }) {
  return <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === 'details' && <><rect x="3.4" y="4.5" width="17.2" height="15" rx="2.4" /><path d="M14.5 5v14M17 9h1M17 12h1" /></>}
    {kind === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
    {kind === 'copy' && <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3" /></>}
    {kind === 'focus' && <path d="M4 9V4h5m6 0h5v5m0 6v5h-5M9 20H4v-5" />}
  </svg>;
}

export function PriorityIconSettings({ current, online, onSaved }: { current: PriorityIcons; online: boolean; onSaved(): Promise<void> }) {
  const [original, setOriginal] = useState(current);
  const [draft, setDraft] = useState(current);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const disabled = !online || busy;
  async function choose(file: File, key: 'attentionImage' | 'highImage') {
    setBusy(true); setMessage('');
    try { const image = await uploadImage(file); setDraft(value => ({ ...value, [key]: image.id })); }
    catch (error) { setMessage(error instanceof Error ? error.message : '这张图未能读取。'); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true); setMessage('');
    try { const saved = await api.setPriorityIcons({ previous: original, value: draft }); setOriginal(saved); await onSaved(); setMessage('优先级图标已保存。'); }
    catch (error) { setMessage(error instanceof Error ? error.message : '图标设置未能保存。'); }
    finally { setBusy(false); }
  }
  return <section className="priority-icon-settings" aria-label="优先级图标"><h3>优先级图标</h3>
    <div role="group" aria-label="图标样式">{([['ink-cat', '墨色黑猫'], ['ginger-cat', '条纹橘猫'], ['custom', '自定义']] as const).map(([style, name]) =>
      <button key={style} type="button" disabled={disabled} aria-pressed={draft.style === style} onClick={() => { setMessage(''); setDraft(v => ({ ...v, style })); }}>
        {name}{style !== 'custom' && <span aria-hidden="true"><PriorityIcon icons={{...draft, style}} level="p2" /><PriorityIcon icons={{...draft, style}} level="p1" /></span>}
      </button>)}</div>
    {draft.style === 'custom' && <div className="priority-custom-inputs">{([['attentionImage', '关注'], ['highImage', '优先']] as const).map(([key, label]) =>
      <label key={key}>{draft[key] && <img src={mediaUrl(draft[key])} alt="" />}{label}<input type="file" disabled={disabled} accept="image/png,image/jpeg,image/webp" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''; if (file) void choose(file, key);
      }} /></label>)}</div>}
    <button type="button" disabled={disabled || JSON.stringify(draft) === JSON.stringify(current) || draft.style === 'custom' && (!draft.attentionImage || !draft.highImage)} onClick={() => void save()}>应用图标</button>
    {JSON.stringify(original) !== JSON.stringify(current) && <button type="button" disabled={disabled} onClick={() => { setOriginal(current); setDraft(current); setMessage(''); }}>载入看板当前图标</button>}
    {message && <small role="status">{message}</small>}
  </section>;
}
