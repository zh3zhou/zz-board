import { useId } from 'react';
import type { InkCanvasTool, InkEraserMode, InkLassoMode, InkPreset } from './InkCanvas.js';
import './ink.css';
import { ColorPalette, DEFAULT_COLOR_SLOTS } from './ColorPalette.js';

export interface InkToolShortcuts {
  select: string;
  pen: string;
  highlighter: string;
  eraser: string;
  lasso: string;
}

export interface ToolPaletteProps {
  tool: InkCanvasTool;
  preset: InkPreset;
  eraserMode: InkEraserMode;
  lassoMode: InkLassoMode;
  shortcuts?: Partial<InkToolShortcuts>;
  onToolChange(tool: InkCanvasTool): void;
  onPresetChange(preset: InkPreset): void;
  onEraserModeChange(mode: InkEraserMode): void;
  onLassoModeChange(mode: InkLassoMode): void;
  colorSlots?: string[];
  skinPalette?: { colors: string[]; widths: number[] };
  onColorSlotsChange?(slots: string[], selectedColor: string): void;
  exportActive?: boolean;
  onExport?(): void;
}

const DEFAULT_SHORTCUTS: InkToolShortcuts = {
  select: 'V', pen: 'P', highlighter: 'H', eraser: 'E', lasso: 'L'
};

export function ToolPalette({
  tool, preset, eraserMode, lassoMode, shortcuts: shortcutOverrides,
  onToolChange, onPresetChange, onEraserModeChange, onLassoModeChange, colorSlots, skinPalette, onColorSlotsChange, exportActive = false, onExport
}: ToolPaletteProps) {
  const widthList = useId();
  const shortcuts = { ...DEFAULT_SHORTCUTS, ...shortcutOverrides };

  if (exportActive) return <div className="zz-tool-palette is-export-tool" role="toolbar" aria-label="画布导出工具"><button className="is-active" aria-label="结束区域导出" aria-pressed="true" title="结束区域导出，返回画布" onClick={onExport}><ToolIcon kind="export" /></button><span>区域导出</span></div>;

  const brushControls = (tool === 'pen' || tool === 'highlighter') && <>
    <ColorPalette label={tool === 'highlighter' ? '荧光笔颜色' : '画笔颜色'} value={preset.color} opacity={preset.opacity}
      suggestedColors={skinPalette?.colors}
      slots={tool === 'highlighter' ? colorSlots || DEFAULT_COLOR_SLOTS : undefined}
      onSlotsChange={tool === 'highlighter' ? onColorSlotsChange : undefined}
      onChange={color => onPresetChange({ ...preset, color })} />
    <label className="zz-tool-palette__size" title={`粗细 ${Math.round(preset.size)}`}>
      <span className="sr-only">{toolLabel(tool)}粗细</span>
      <input type="range" min={skinPalette ? .5 : 1} max={Math.max(tool === 'highlighter' ? 72 : 36, ...(skinPalette?.widths ?? []))} step={skinPalette ? 'any' : 1} list={skinPalette ? widthList : undefined} value={preset.size}
        aria-valuetext={`${preset.size} 像素`} onChange={event => onPresetChange({ ...preset, size: Number(event.target.value) })} />
      {skinPalette && <datalist id={widthList}>{skinPalette.widths.map((width, index) => <option key={index} value={width} />)}</datalist>}
    </label>
  </>;

  const tools: InkCanvasTool[] = ['select', 'pen', 'highlighter', 'eraser', 'lasso'];
  return <div className="zz-tool-palette" role="toolbar" aria-label="绘制工具">
    {tools.map((candidate) => <button
      key={candidate}
      className={tool === candidate ? 'is-active' : ''}
      aria-label={toolLabel(candidate)}
      aria-pressed={tool === candidate}
      title={`${toolLabel(candidate)} (${shortcuts[candidate]})`}
      onClick={() => onToolChange(candidate)}
    ><ToolIcon kind={candidate} /></button>)}
    {onExport && <><span className="zz-tool-palette__separator" aria-hidden="true" /><button aria-label="导出区域 PNG" title="导出区域 PNG" onClick={onExport}><ToolIcon kind="export" /></button></>}
    {tool !== 'select' && <div className="zz-tool-options" role="group" aria-label={`${toolLabel(tool)}选项`}>
      {brushControls}
      {(tool === 'pen' || tool === 'highlighter') &&
        <button
          className={preset.layer === 'background' ? 'is-active' : ''}
          aria-label={preset.layer === 'background' ? '墨迹位于气泡下方' : '墨迹位于气泡上方'}
          title={preset.layer === 'background' ? '气泡下方' : '气泡上方'}
          onClick={() => onPresetChange({ ...preset, layer: preset.layer === 'background' ? 'foreground' : 'background' })}
        ><ToolIcon kind={preset.layer === 'background' ? 'background' : 'foreground'} /></button>
      }
      {tool === 'eraser' && <button
        className="zz-tool-palette__mode"
        aria-label={eraserMode === 'whole' ? '整笔擦除' : '精细擦除'}
        title={eraserMode === 'whole' ? '整笔擦除' : '精细擦除'}
        onClick={() => onEraserModeChange(eraserMode === 'whole' ? 'precision' : 'whole')}
      ><ToolIcon kind={eraserMode === 'whole' ? 'whole' : 'precision'} /></button>}
      {tool === 'lasso' && <button
        className="zz-tool-palette__mode"
        aria-label={lassoMode === 'inkOnly' ? '只选择墨迹' : '选择墨迹与气泡便签'}
        title={lassoMode === 'inkOnly' ? '只选择墨迹' : '选择墨迹与气泡便签'}
        onClick={() => onLassoModeChange(lassoMode === 'inkOnly' ? 'includeObjects' : 'inkOnly')}
      ><ToolIcon kind={lassoMode === 'inkOnly' ? 'inkOnly' : 'includeObjects'} /></button>}
    </div>}
  </div>;
}

type IconKind = InkCanvasTool | 'background' | 'foreground' | 'whole' | 'precision' | 'inkOnly' | 'includeObjects' | 'export';

function ToolIcon({ kind }: { kind: IconKind }) {
  if (kind === 'export') return <svg viewBox="0 0 24 24"><path d="M4 9V4h5M15 4h5v5M4 15v5h5M20 15v5h-5M12 7v10m-4-4 4 4 4-4" /></svg>;
  if (kind === 'select') return <svg viewBox="0 0 24 24"><path d="m6 3 11 9-5 .8 3 6-2.6 1.2-3-6-3.4 3Z" /></svg>;
  if (kind === 'pen') return <svg viewBox="0 0 24 24"><path d="m5 19 3.8-.8L19 8l-3-3L5.8 15.2Zm9.6-12.6 3 3" /></svg>;
  if (kind === 'highlighter') return <svg viewBox="0 0 24 24"><path d="m7 15 8-10 4 3-8 10Zm-2 4h10M7 15l4 3" /></svg>;
  if (kind === 'eraser') return <svg viewBox="0 0 24 24"><path d="m4.5 15.5 8-10a2 2 0 0 1 2.8-.3l3.5 2.8a2 2 0 0 1 .3 2.8l-6.5 8.2H7.8Z" /></svg>;
  if (kind === 'lasso') return <svg viewBox="0 0 24 24"><path d="M18 16c2.4-1.4 3.5-3.7 2.4-5.8C18.9 7.3 13.8 6 9.2 7.3 4.6 8.6 2 12 3.5 15c1.4 2.8 6.2 4 10.5 2.9 2-.5 3.5-1.4 4-2.6.4-1-.4-1.8-1.5-1.6-1.4.3-2 1.8-1.2 3.2.8 1.5 2.7 2.4 4.7 2.1" /></svg>;
  if (kind === 'background') return <svg viewBox="0 0 24 24"><path d="M5 8h10v10H5zM9 4h10v10M4 21h16" /></svg>;
  if (kind === 'foreground') return <svg viewBox="0 0 24 24"><path d="M9 4h10v10H9zM5 8h10v10H5zM4 21h16" /></svg>;
  if (kind === 'whole') return <svg viewBox="0 0 24 24"><path d="m5 15 7-9 7 6-6 7H9Zm1-11 14 16" /></svg>;
  if (kind === 'precision') return <svg viewBox="0 0 24 24"><path d="m7 15 6-8 5 4-6 8H9ZM3 20h18" /></svg>;
  if (kind === 'inkOnly') return <svg viewBox="0 0 24 24"><path d="M4 15c4-9 8 6 16-4M5 19h14" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M4 7h7v7H4zM13 10h7v7h-7zM3 20c5-8 9 4 18-3" /></svg>;
}

function toolLabel(tool: InkCanvasTool): string {
  if (tool === 'select') return '选择';
  if (tool === 'pen') return '画笔';
  if (tool === 'highlighter') return '荧光笔';
  if (tool === 'eraser') return '橡皮擦';
  return '套索';
}
