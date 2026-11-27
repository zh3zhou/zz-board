export type ShortcutAction =
  | 'menu'
  | 'newNote'
  | 'priority1'
  | 'priority2'
  | 'priority3'
  | 'priorityClear'
  | 'selectTool'
  | 'penTool'
  | 'highlighterTool'
  | 'eraserTool'
  | 'lassoTool'
  | 'undo'
  | 'redo'
  | 'fitView';

export type ShortcutMap = Record<ShortcutAction, string>;

export const defaultShortcuts: ShortcutMap = {
  menu: 'M',
  newNote: 'N',
  priority1: '1',
  priority2: '2',
  priority3: '3',
  priorityClear: '0',
  selectTool: 'V',
  penTool: 'P',
  highlighterTool: 'H',
  eraserTool: 'E',
  lassoTool: 'L',
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Shift+Z',
  fitView: 'F'
};

export const shortcutLabels: Record<ShortcutAction, string> = {
  menu: '菜单',
  newNote: '新建便签',
  priority1: '标为优先',
  priority2: '标为关注',
  priority3: '标为关注（兼容旧快捷键）',
  priorityClear: '清除手动优先级',
  selectTool: '选择工具',
  penTool: '画笔',
  highlighterTool: '荧光笔',
  eraserTool: '橡皮擦',
  lassoTool: '套索',
  undo: '撤销',
  redo: '重做',
  fitView: '看全画布'
};

const fixedBindings = new Set(['ESCAPE', 'SPACE', 'CTRL+ENTER', 'BACKSPACE', 'DELETE']);

export function normalizeShortcut(value: string): string {
  const parts = value.trim().replaceAll('⌘', 'Meta').replaceAll('⌃', 'Ctrl').split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return '';
  const modifiers = new Set(parts.slice(0, -1).map(normalizeModifier));
  const key = (parts.at(-1) || '').length === 1 ? (parts.at(-1) || '').toUpperCase() : normalizeKey(parts.at(-1) || '');
  return [...(['Ctrl', 'Meta', 'Alt', 'Shift'] as const).filter((modifier) => modifiers.has(modifier)), key].filter(Boolean).join('+');
}

export function mergeShortcuts(value: unknown): ShortcutMap {
  if (!value || typeof value !== 'object') return { ...defaultShortcuts };
  const entries = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(defaultShortcuts).map(([action, fallback]) => {
    const candidate = typeof entries[action] === 'string' ? normalizeShortcut(entries[action]) : '';
    return [action, candidate || fallback];
  })) as ShortcutMap;
}

export function shortcutConflicts(value: ShortcutMap): Array<{ binding: string; actions: ShortcutAction[] }> {
  const grouped = new Map<string, ShortcutAction[]>();
  for (const [action, raw] of Object.entries(value) as Array<[ShortcutAction, string]>) {
    const binding = normalizeShortcut(raw);
    const actions = grouped.get(binding) || [];
    actions.push(action);
    grouped.set(binding, actions);
  }
  return [...grouped.entries()]
    .filter(([binding, actions]) => !binding || actions.length > 1 || fixedBindings.has(binding.toUpperCase()))
    .map(([binding, actions]) => ({ binding, actions }));
}

export function shortcutFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): string {
  const key = normalizeKey(event.key);
  return [event.ctrlKey ? 'Ctrl' : '', event.metaKey ? 'Meta' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key]
    .filter(Boolean).join('+');
}

export function shortcutMatches(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, binding: string): boolean {
  return shortcutFromEvent(event) === normalizeShortcut(binding);
}

export function panelOwnsCanvasKeys(overlayOpen: boolean, target: Pick<Element, 'closest'> | null): boolean {
  return overlayOpen || Boolean(target?.closest('.panel-shell, .control-drawer, .modal-backdrop, .image-viewer'));
}

export function startsCanvasPan(event: Pick<KeyboardEvent, 'code' | 'defaultPrevented' | 'isComposing' | 'repeat' | 'altKey' | 'ctrlKey' | 'metaKey'>, target: Pick<Element, 'closest'> | null, overlayOpen = false): boolean {
  if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return false;
  return !panelOwnsCanvasKeys(overlayOpen, target) &&
    !target?.closest('button, a[href], summary, input, select, textarea, [role="button"], [role="textbox"], [role="tab"], [contenteditable]:not([contenteditable="false"]), .zz-tool-palette');
}

function normalizeModifier(value: string): string {
  const lower = value.toLowerCase();
  if (lower === 'control' || lower === 'ctrl') return 'Ctrl';
  if (lower === 'command' || lower === 'cmd' || lower === 'meta') return 'Meta';
  if (lower === 'option' || lower === 'alt') return 'Alt';
  if (lower === 'shift') return 'Shift';
  return value;
}

function normalizeKey(value: string): string {
  if (!value) return '';
  const aliases: Record<string, string> = { ' ': 'Space', spacebar: 'Space', esc: 'Escape', del: 'Delete' };
  const lower = value.toLowerCase();
  const normalized = aliases[lower] || value;
  return normalized.length === 1 ? normalized.toUpperCase() : normalized[0]?.toUpperCase() + normalized.slice(1);
}
