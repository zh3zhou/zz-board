import { useEffect, useRef, useState, type CSSProperties } from 'react';
import './ink.css';

export const DEFAULT_COLOR_SLOTS = ['#f1c75b', '#f39dba', '#a4d785', '#86c9ed', '#b9a1e3', '#f2aa73'];

export function colorChannels(value: string): number[] {
  const safe = /^#[0-9a-f]{6}$/i.test(value) ? value : '#23201d';
  return [1, 3, 5].map((offset) => Number.parseInt(safe.slice(offset, offset + 2), 16));
}

export function colorFromChannels(channels: number[]): string {
  return `#${channels.map((channel) => Math.max(0, Math.min(255, Math.round(channel || 0))).toString(16).padStart(2, '0')).join('')}`;
}

interface ColorPaletteProps {
  label: string;
  value: string;
  opacity?: number;
  slots?: string[];
  suggestedColors?: string[];
  onSlotsChange?(slots: string[], selectedColor: string): void;
  onChange(color: string): void;
  placement?: 'above' | 'below';
}

/** Shared chrome only: native RGB selection remains available; all colors stay local. */
export function ColorPalette({ label, value, opacity = 1, slots, suggestedColors, onSlotsChange, onChange, placement = 'above' }: ColorPaletteProps) {
  const [open, setOpen] = useState(false);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const channels = colorChannels(value);
  const safeValue = colorFromChannels(channels);
  const visibleSlots = slots ? DEFAULT_COLOR_SLOTS.map((fallback, index) => slots[index] || fallback) : null;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function change(color: string) {
    if (visibleSlots && activeSlot !== null && onSlotsChange) onSlotsChange(visibleSlots.map((slot, index) => index === activeSlot ? color : slot), color);
    else onChange(color);
  }

  return <div ref={root} className={`zz-color-picker nodrag nopan zz-color-picker--${placement}`}
    onKeyDown={(event) => { if (event.key === 'Escape' && open) { event.stopPropagation(); setOpen(false); } }}>
    <div className="zz-color-slots" aria-label={label}>
      {visibleSlots ? visibleSlots.map((color, index) => <button key={index} type="button" className={`zz-color-swatch${color.toLowerCase() === safeValue ? ' is-current' : ''}`}
        aria-label={`${label}自定义色 ${index + 1}`} title={`自定义色 ${index + 1} · 点击使用并调整`} aria-expanded={open && activeSlot === index}
        style={{ '--swatch-color': color } as CSSProperties} onClick={() => { setActiveSlot(index); onChange(color); setOpen(true); }} />)
        : <button type="button" className="zz-color-swatch" aria-label={label} title={label} aria-expanded={open}
          style={{ '--swatch-color': safeValue } as CSSProperties} onClick={() => { setActiveSlot(null); setOpen(!open); }} />}
    </div>
    {open && <div className="zz-color-popover" role="dialog" aria-label={`${label}色板`}>
      <header><span>{activeSlot === null ? label : `自定义色 ${activeSlot + 1}`}</span><button type="button" aria-label="关闭色板" onClick={() => setOpen(false)}>×</button></header>
      <div className="zz-color-preview" aria-label={`笔迹预览，透明度 ${Math.round(opacity * 100)}%`}>
        <span>笔迹预览</span><i style={{ backgroundColor: safeValue, opacity }} />
      </div>
      {suggestedColors && <div className="zz-color-slots skin-ink-swatches" role="group" aria-label="Skin 配色">{suggestedColors.map((color, index) =>
        <button type="button" key={index} className="zz-color-swatch" aria-label={`使用 Skin 颜色 ${color}`}
          style={{ '--swatch-color': color } as CSSProperties} onClick={() => change(color.slice(0, 7))} />)}</div>}
      <label className="zz-color-native">自由选色<input type="color" aria-label={`${label}自由选色`} value={safeValue} onChange={(event) => change(event.target.value)} /></label>
      <div className="zz-color-rgb">{['R', 'G', 'B'].map((channel, index) => <label key={channel}>{channel}<input type="number" min="0" max="255" step="1" aria-label={`${label} ${channel}`} value={channels[index]}
        onChange={(event) => change(colorFromChannels(channels.map((number, candidate) => candidate === index ? Number(event.target.value) : number)))} /></label>)}</div>
      <span className="zz-color-hex">{safeValue.toUpperCase()}{activeSlot !== null ? ' · 此色位自动记住' : ''}</span>
    </div>}
  </div>;
}
