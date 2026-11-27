import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WallpaperScene, WallpaperSettings } from '../../src/web/WallpaperSettings.js';
import { layerStyle } from '../../src/web/WallpaperScene.js';
import { moveWallpaperImage, studioPoint, WallpaperStudio } from '../../src/web/WallpaperStudio.js';
import type { CanvasPageRecord } from '../../src/shared/pages.js';
import type { Wallpaper } from '../../src/shared/wallpaper.js';
import { api } from '../../src/web/api.js';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
vi.mock('react', async original => ({
  ...await original<typeof import('react')>(),
  useState(initial: unknown) {
    const i = hooks.index++;
    if (!(i in hooks.values)) hooks.values[i] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[i], (value: unknown) => { hooks.values[i] = value; }];
  },
  useRef: (initial: unknown) => hooks.values[hooks.index++] ??= { current: initial }, useEffect: () => {}, useLayoutEffect: (run: () => void) => run()
}));
beforeEach(() => { hooks.index = 0; hooks.values = []; });

function elements(tree: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  return isValidElement<Record<string, any>>(tree) ? [tree, ...elements(tree.props.children)] : [];
}

it('saves the page image the user was adjusting when the inherited wallpaper changes in another window', async () => {
  const page: CanvasPageRecord = { id:'paper', name:'内页', revision:2, sortOrder:0, backgroundSkinRef:null, archivedAt:null,
    autoCheckPaused:false, createdAt:'', updatedAt:'', viewport:{x:0,y:0,zoom:1} };
  const original: Wallpaper = { assetId:'a'.repeat(64), fit:'cover', opacity:.5 };
  const update = vi.spyOn(api, 'updatePage').mockResolvedValue(page);
  const saved = vi.fn(async () => {});
  function render(global: Wallpaper | null) {
    hooks.index = 0;
    const wrapper = WallpaperSettings({global, page, initialScope: 'page', online:true, onSaved:saved});
    const editor = elements(wrapper).find(e => typeof e.type === 'function')!;
    const Editor = editor.type as (props: typeof editor.props) => ReactNode;
    return elements(Editor(editor.props));
  }
  const controls = render(original);
  controls.find(e => e.type === 'input' && e.props.type === 'range')!.props.onChange({target:{value:'75'}});
  const afterRemoval = render(null);
  expect(afterRemoval.find(e => e.type === WallpaperScene)?.props.value).toEqual({...original, opacity:.75});
  afterRemoval.find(e => e.type === 'button' && e.props.children === '应用背景图')!.props.onClick();
  await vi.waitFor(() => expect(saved).toHaveBeenCalledOnce());
  expect(update).toHaveBeenCalledWith(page.id, {revision:2, backgroundSkinRef:null, wallpaper:{...original, opacity:.75}});
  vi.restoreAllMocks();
});

it('starts at the requested scope and protects unapplied work when leaving either menu route', () => {
  const page = { id: 'sample-page', name: '合成页', archivedAt: null } as CanvasPageRecord;
  const guard = { current: null as (() => boolean) | null };
  const confirm = vi.fn(() => false);
  vi.stubGlobal('window', { confirm });
  try {
    for (const scope of ['board', 'page'] as const) {
      hooks.index = 0; hooks.values = [];
      const wrapper = WallpaperSettings({ global: null, page, online: true, initialScope: scope, leaveGuard: guard, onSaved: async () => {} });
      const controls = elements(wrapper);
      expect(controls.find(item => item.type === 'select')!.props.value).toBe(scope);
      expect(guard.current?.()).toBe(true);
      const editor = controls.find(item => typeof item.type === 'function')!;
      editor.props.reportDirty(true);
      expect(guard.current?.()).toBe(false);
      confirm.mockReturnValueOnce(true);
      expect(guard.current?.()).toBe(true);
    }
  } finally { vi.unstubAllGlobals(); }
});

it('uses the same viewport-relative position in the arrangement preview and the full canvas', () => {
  const start = studioPoint(110, 60, {left:10, top:10, width:200, height:100});
  const end = studioPoint(160, 40, {left:10, top:10, width:200, height:100});
  const placement = moveWallpaperImage({ x:10, y:0, scale:60 }, start, end);
  expect(placement).toEqual({ x:35, y:-20, scale:60 });
  const image = { assetId:'b'.repeat(64), fit:'contain' as const, opacity:.4, placement };
  expect(layerStyle(image, '/test-image', .25)).toEqual(layerStyle(image, '/test-image', 1));
  expect(layerStyle(image, '/test-image')).toMatchObject({ top:'0%', left:'55%', height:'60%', opacity:.4 });
  expect(layerStyle({ ...image, fit:'tile', placement:{ x:4, y:5, scale:200 } }, '/test-image', .5))
    .toMatchObject({ backgroundPosition:'4cqw 5cqh', backgroundImage:'image-set(url("/test-image") 1x)' });
});

it('commits one placement or ink stroke at pointer-up and discards cancelled gestures', () => {
  let value: Wallpaper = { assetId:'a'.repeat(64), fit:'cover', opacity:.75 };
  const change = vi.fn((v: Wallpaper) => { value = v; });
  const render = () => {
    hooks.index = 0;
    return elements(WallpaperStudio({ value, index:0, locked:false, urlFor:id => id, onChange:change }));
  };
  const surface = () => render().find(e => e.props['aria-label'] === '背景布置画布')!.props;
  const target = { getBoundingClientRect:() => ({ left:10, top:10, width:200, height:100 }), setPointerCapture:vi.fn() };
  const event = (x: number, y: number) => ({ clientX:x, clientY:y, currentTarget:target, button:0, pointerId:2, preventDefault(){} });
  surface().onPointerDown(event(110,60));
  surface().onPointerMove(event(140,40));
  expect(change).not.toHaveBeenCalled();
  surface().onPointerUp(event(160,40));
  expect(value.placement).toEqual({ x:25, y:-20, scale:100 });
  render().find(e => e.type === 'button' && e.props.children === '画笔')!.props.onClick();
  surface().onPointerDown(event(10,10));
  surface().onPointerMove(event(110,60));
  surface().onPointerCancel(event(110,60));
  expect(change).toHaveBeenCalledTimes(1);
  surface().onPointerDown(event(10,10));
  surface().onPointerMove(event(110,60));
  surface().onPointerUp(event(210,110));
  expect(value.strokes?.[0]?.points).toEqual([[0,0],[500,500],[1000,1000]]);
  expect(value.placement).toEqual({ x:25, y:-20, scale:100 });
});
