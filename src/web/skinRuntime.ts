import type { CSSProperties } from 'react';
import type { SkinComponents } from '../shared/schema.js';
import {
  createSkinReference,
  contrastRatio,
  DEFAULT_SKIN_KEY,
  LEGACY_SKIN_KEY,
  getSkinComponent,
  parseSkinReference,
  skinVersionKey,
  type SkinComponentId,
  type SkinManifest,
  type SkinPackage,
  type SkinShapeKind,
  type SkinSurface
} from '../shared/skin.js';

export const FALLBACK_SKIN_KEY = LEGACY_SKIN_KEY;
export type SkinStyle = CSSProperties & Record<`--${string}`, string | number>;
type SkinSource = SkinManifest | Pick<SkinPackage, 'manifest'>;

const skinVariableNames = [
  '--paper', '--paper-soft', '--panel', '--panel-elevated', '--ink', '--muted', '--hairline', '--accent', '--accent-soft', '--danger', '--shadow', '--grid-dot', '--minimap-mask',
  '--chrome-radius', '--chrome-border-width', '--chrome-highlight', '--chrome-blur',
  '--chrome-material-image', '--chrome-backdrop', '--priority-attention', '--priority-high', '--on-priority-attention', '--on-priority-high',
  '--skin-pattern-size', '--task-material-image', '--task-backdrop', '--note-skin-material-image', '--note-skin-backdrop', '--note-reading-radius', '--note-reading-texture',
  '--skin-drift-name', '--skin-breathe-name',
  '--chrome-color-scheme', '--control-bg', '--control-text', '--control-muted', '--control-border', '--control-hover', '--control-hover-text', '--control-focus', '--control-accent', '--on-accent',
  '--skin-background', '--skin-background-accent', '--skin-pattern-opacity', '--skin-background-image', '--skin-background-texture', '--skin-background-texture-opacity',
  '--task-fill', '--task-text', '--task-border', '--task-accent', '--task-shadow', '--task-radius', '--task-opacity', '--task-texture-image', '--task-border-width', '--task-elevation-y', '--task-elevation-blur', '--task-highlight', '--task-shape-kind', '--task-aspect-default',
  '--note-skin-fill', '--note-skin-text', '--note-skin-border', '--note-skin-accent', '--note-skin-shadow', '--note-skin-radius', '--note-skin-opacity', '--note-skin-texture-image', '--note-skin-border-width', '--note-skin-elevation-y', '--note-skin-elevation-blur', '--note-skin-highlight', '--note-skin-shape-kind', '--note-skin-aspect-default',
  '--edge', '--skin-link-highlight', '--skin-link-width', '--skin-link-opacity', '--skin-link-dash', '--skin-ink-primary', '--skin-ink-selection', '--skin-highlighter-opacity',
  '--skin-motion-duration', '--skin-motion-amplitude', '--skin-shadow-pulse'
] as const;

export function applySkinVariables(target: Pick<CSSStyleDeclaration, 'setProperty'> & Partial<Pick<CSSStyleDeclaration, 'removeProperty'>>, style: SkinStyle): void {
  if (target.removeProperty) {
    for (const name of skinVariableNames) if (!(name in style)) target.removeProperty(name);
  }
  for (const [name, value] of Object.entries(style)) {
    if (!name.startsWith('--') || value === undefined || value === null) continue;
    target.setProperty(name, String(value));
  }
}

export function defaultComponentReference(skin: Pick<SkinManifest, 'skinId' | 'version'>, component: SkinComponentId): string {
  return createSkinReference(skin, component);
}

export function packageForReference(packages: readonly SkinPackage[], reference: string | null | undefined): SkinPackage | undefined {
  if (!reference) return undefined;
  try {
    const parsed = parseSkinReference(reference);
    return packages.find((item) => skinVersionKey(item.manifest) === `${parsed.skinId}@${parsed.version}`);
  } catch {
    return undefined;
  }
}

export function manifestForReference(manifests: readonly SkinManifest[], reference: string | null | undefined): SkinManifest | undefined {
  if (!reference) return undefined;
  if (!reference.includes('/')) return manifests.find((item) => skinVersionKey(item) === reference);
  try {
    const parsed = parseSkinReference(reference);
    return manifests.find((item) => skinVersionKey(item) === `${parsed.skinId}@${parsed.version}`);
  } catch {
    return undefined;
  }
}

export function composedSkinStyle(manifests: readonly SkinManifest[], activeKey: string | null | undefined, components: SkinComponents = {}): SkinStyle {
  const result: SkinStyle = {
    '--skin-background-texture': 'none', '--skin-background-texture-opacity': '0',
    '--skin-pattern-size': '34px 34px', '--chrome-material-image': 'none', '--chrome-backdrop': 'initial',
    '--skin-drift-name': 'bubble-drift', '--skin-breathe-name': 'bubble-breathe',
    '--task-texture-image': 'none', '--note-skin-texture-image': 'none',
    '--skin-motion-duration': '16000ms', '--skin-motion-amplitude': '6px', '--skin-shadow-pulse': '0.05'
  };
  for (const componentId of ['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette'] as const) {
    const source = skinComponentManifest(manifests, activeKey, componentId, components[componentId]);
    Object.assign(result, componentSkinStyle(source, componentId));
  }
  return result;
}

export function skinComponentManifest(manifests: readonly SkinManifest[], activeKey: string | null | undefined, id: SkinComponentId, reference?: string): SkinManifest | undefined {
  const requested = manifestForReference(manifests, reference);
  if (hasComponent(requested, id)) return requested;
  const active = manifestForReference(manifests, activeKey);
  if (hasComponent(active, id)) return active;
  // Partial V1/V2 packages historically borrowed V2 components.
  const fallbackKey = active && active.schemaVersion < 3 ? FALLBACK_SKIN_KEY : DEFAULT_SKIN_KEY;
  return manifestForReference(manifests, fallbackKey) || manifests.find((manifest) => hasComponent(manifest, id));
}

export function globalSkinStyle(source: SkinSource | undefined): SkinStyle {
  if (!source) return {};
  const manifest = 'manifest' in source ? source.manifest : source;
  return Object.assign({}, ...(['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette'] as const).map((id) => componentSkinStyle(manifest, id)));
}

export function componentSkinStyle(manifest: SkinManifest | undefined, componentId: SkinComponentId): SkinStyle {
  if (!manifest) return {};
  const style: SkinStyle = {};
  const component = getSkinComponent(manifest, componentId);
  if (componentId === 'background' && component && 'surface' in component && 'pattern' in component) {
    style['--paper'] = component.surface;
    style['--skin-background'] = component.surface;
    style['--skin-background-accent'] = component.accent;
    style['--skin-pattern-opacity'] = String(component.patternOpacity);
    style['--skin-background-image'] = backgroundPattern(component.pattern, component.accent, component.patternOpacity);
    if (manifest.schemaVersion === 3) {
      style['--skin-pattern-size'] = component.pattern === 'grid' ? '26px 26px, 26px 26px'
        : component.pattern === 'dots' ? '24px 24px' : component.pattern === 'wash' ? 'auto, auto' : 'auto';
    }
    // The V3 background already owns its pattern. Older Skins used an additional React Flow dot grid.
    style['--grid-dot'] = manifest.schemaVersion === 3 ? 'transparent' : colorWithAlpha(component.accent, 52);
    if (component.textureAssetId) {
      style['--skin-background-texture'] = assetUrl(manifest, component.textureAssetId);
      style['--skin-background-texture-opacity'] = String(component.textureOpacity);
    }
  }
  if (componentId === 'chrome' && component && 'panelElevated' in component) {
    Object.assign(style, chromeVariables(component, manifest));
  }
  if ((componentId === 'taskBubble' || componentId === 'note') && component && 'fill' in component) {
    const prefix = componentId === 'note' ? 'note-skin' : 'task';
    Object.assign(style, surfaceVariables(prefix, component, manifest));
  }
  if (componentId === 'link' && component && 'width' in component && 'highlight' in component && 'style' in component) {
    style['--edge'] = component.color;
    style['--skin-link-highlight'] = component.highlight;
    style['--skin-link-width'] = `${component.width}px`;
    style['--skin-link-opacity'] = String(component.opacity);
    style['--skin-link-dash'] = component.style === 'dashed' ? '10 7' : component.style === 'dotted' ? '2 7' : 'none';
  }
  if (componentId === 'inkPalette' && component && 'colors' in component) {
    style['--skin-ink-primary'] = component.colors[0]!;
    style['--skin-ink-selection'] = component.selection;
    style['--skin-highlighter-opacity'] = String(component.highlighterOpacity);
  }
  const motion = manifest.motion;
  if (motion) {
    style['--skin-motion-duration'] = `${motion.durationMs}ms`;
    style['--skin-motion-amplitude'] = `${motion.amplitudePx}px`;
    style['--skin-shadow-pulse'] = String(motion.shadowPulse);
    if (manifest.schemaVersion === 3 && componentId === 'taskBubble') {
      style['--skin-drift-name'] = motion.kind === 'drift' ? 'bubble-drift' : 'none';
      style['--skin-breathe-name'] = motion.kind === 'none' ? 'none' : 'bubble-breathe';
    }
  }
  return style;
}

export function nodeSkinStyle(skinPackage: SkinPackage | undefined, componentId: 'taskBubble' | 'note'): SkinStyle {
  return nodeManifestSkinStyle(skinPackage?.manifest, componentId);
}

export function nodeManifestSkinStyle(manifest: SkinManifest | undefined, componentId: 'taskBubble' | 'note'): SkinStyle {
  if (!manifest) return {};
  const component = getSkinComponent(manifest, componentId);
  const prefix = componentId === 'note' ? 'note-skin' : 'task';
  return component && 'fill' in component
    ? surfaceVariables(prefix, component, manifest)
    : {};
}

export function skinPalette(skinPackage: SkinPackage | undefined): { colors: string[]; widths: number[]; highlighterOpacity: number; selection: string } | undefined {
  if (!skinPackage) return undefined;
  const component = getSkinComponent(skinPackage.manifest, 'inkPalette');
  return component && 'colors' in component ? component : undefined;
}

export function skinShape(manifest: SkinManifest | undefined, componentId: 'taskBubble' | 'note'): SkinShapeKind {
  if (!manifest) return componentId === 'taskBubble' ? 'circle' : 'roundedRect';
  const component = getSkinComponent(manifest, componentId);
  return component && 'shape' in component ? component.shape.kind : 'roundedRect';
}

export function skinCornerRadii(manifest: SkinManifest | undefined, componentId: 'taskBubble' | 'note'): readonly number[] | undefined {
  if (!manifest) return undefined;
  const component = getSkinComponent(manifest, componentId);
  return component && 'shape' in component && component.shape.kind === 'softBlob' ? component.shape.cornerRadii : undefined;
}

export function skinAspectLockedDefault(manifest: SkinManifest | undefined, componentId: 'taskBubble' | 'note'): boolean {
  if (!manifest) return componentId === 'taskBubble';
  const component = getSkinComponent(manifest, componentId);
  return component && 'shape' in component ? component.shape.aspectLockedDefault : false;
}

function hasComponent(manifest: SkinManifest | undefined, componentId: SkinComponentId): boolean {
  return Boolean(manifest && getSkinComponent(manifest, componentId));
}

type ChromeComponent = Extract<NonNullable<ReturnType<typeof getSkinComponent>>, { panelElevated: string }>;
function chromeVariables(chrome: ChromeComponent, manifest: SkinManifest): SkinStyle {
  const elevation = elevationTokens(chrome.elevation);
  const priority = manifest.schemaVersion === 3 ? manifest.foundation.priority : { attention: '#E8D4A8', high: '#934A32' };
  return {
    ...controlVariables(chrome),
    '--panel': chrome.panel, '--panel-elevated': chrome.panelElevated, '--paper-soft': chrome.panelElevated,
    '--ink': chrome.text, '--muted': chrome.muted, '--hairline': chrome.border, '--accent': chrome.accent,
    '--accent-soft': chrome.accentSoft, '--danger': chrome.danger,
    '--shadow': `0 ${elevation.y}px ${elevation.blur}px ${colorWithAlpha(chrome.border, Math.round((0.16 + chrome.elevation * 0.035) * 255))}`,
    '--chrome-radius': `${chrome.radius}px`, '--chrome-border-width': `${(0.5 + chrome.borderStrength * 1.4).toFixed(2)}px`,
    '--chrome-highlight': String(chrome.highlightIntensity), '--chrome-blur': chrome.material === 'glass' ? '18px' : '0px',
    ...(manifest.schemaVersion === 3 ? {
      '--chrome-material-image': materialImage(chrome.material, chrome.text, chrome.highlightIntensity),
      '--chrome-backdrop': chrome.material === 'glass' ? 'blur(15px)' : 'none'
    } : {}),
    '--priority-attention': priority.attention, '--on-priority-attention': readableOn(priority.attention, chrome.text),
    '--priority-high': priority.high, '--on-priority-high': readableOn(priority.high, chrome.text),
    '--minimap-mask': colorWithAlpha(chrome.panel, chrome.mode === 'dark' ? 205 : 190)
  };
}

function readableOn(background: string, preferred: string): string {
  if (contrastRatio(preferred.slice(0, 7), background) >= 4.5) return preferred.slice(0, 7);
  return contrastRatio('#000000', background) > contrastRatio('#FFFFFF', background) ? '#000000' : '#FFFFFF';
}

/** Controls use opaque, paired surfaces: canvas/background mixing must never
 * turn their labels into light-on-light text. Pinned manifests stay unchanged. */
export function controlVariables(chrome: ChromeComponent): SkinStyle {
  const surface = chrome.panelElevated.slice(0, 7), hover = chrome.accentSoft.slice(0, 7);
  const readable = (preferred: string, background: string, minimum = 4.5) => {
    const candidate = [preferred, chrome.muted, chrome.text].map(color => color.slice(0, 7)).find(color => contrastRatio(color, background) >= minimum);
    return candidate ?? readableOn(background, chrome.text);
  };
  return {
    '--chrome-color-scheme': chrome.mode,
    '--control-bg': surface, '--control-text': readable(chrome.text, surface),
    '--control-muted': readable(chrome.muted, surface), '--control-border': readable(chrome.border, surface, 3),
    '--control-hover': hover, '--control-hover-text': readable(chrome.text, hover),
    '--control-focus': readable(chrome.accent, surface, 3), '--control-accent': chrome.accent.slice(0, 7), '--on-accent': readable(chrome.text, chrome.accent.slice(0, 7))
  };
}

function surfaceVariables(prefix: 'task' | 'note-skin', surface: SkinSurface, manifest: SkinManifest): SkinStyle {
  const v2 = 'shape' in surface;
  const shape = v2 ? surface.shape.kind : 'roundedRect';
  const radius = v2 ? shapeRadius(surface.shape) : `${surface.radius}px`;
  const elevation = elevationTokens(v2 ? surface.elevation : 1);
  const recipe = manifest.schemaVersion === 3 && v2;
  const texture = surface.textureAssetId ? assetUrl(manifest, surface.textureAssetId) : 'none';
  return {
    [`--${prefix}-texture-image`]: texture,
    [`--${prefix}-material-image`]: recipe ? materialImage(surface.material, surface.text, surface.highlightIntensity) : 'none',
    [`--${prefix}-backdrop`]: recipe && surface.material === 'glass' ? 'blur(8px)' : 'none',
    ...(prefix === 'note-skin' ? {
      '--note-reading-texture': recipe ? texture : 'none',
      '--note-reading-radius': recipe && shape === 'softBlob' ? '9px 16px 11px 7px' : '14px'
    } : {}),
    [`--${prefix}-fill`]: surface.fill,
    [`--${prefix}-text`]: surface.text,
    [`--${prefix}-border`]: surface.border,
    [`--${prefix}-accent`]: surface.accent,
    [`--${prefix}-shadow`]: surface.shadow,
    [`--${prefix}-radius`]: radius,
    [`--${prefix}-opacity`]: String(surface.opacity),
    [`--${prefix}-border-width`]: `${v2 ? (0.5 + surface.borderStrength * 1.5).toFixed(2) : 1}px`,
    [`--${prefix}-elevation-y`]: `${elevation.y}px`,
    [`--${prefix}-elevation-blur`]: `${elevation.blur}px`,
    [`--${prefix}-highlight`]: String(v2 ? surface.highlightIntensity : 0),
    [`--${prefix}-shape-kind`]: shape,
    [`--${prefix}-aspect-default`]: String(v2 && surface.shape.aspectLockedDefault ? 1 : 0)
  };
}

function shapeRadius(shape: Extract<SkinSurface, { shape: unknown }>['shape']): string {
  if (shape.kind === 'circle' || shape.kind === 'ellipse') return '50%';
  if (shape.kind === 'roundedRect') return '18px';
  if (shape.cornerRadii) {
    const [a, b, c, d, e, f, g, h] = shape.cornerRadii;
    return `${a}% ${b}% ${c}% ${d}% / ${e}% ${f}% ${g}% ${h}%`;
  }
  return '42% 58% 52% 48% / 50% 44% 56% 50%';
}

function elevationTokens(elevation: number): { y: number; blur: number } {
  return elevation === 0 ? { y: 0, blur: 0 } : { y: 4 + elevation * 3, blur: 12 + elevation * 8 };
}

function materialImage(material: ChromeComponent['material'], text: string, intensity: number): string {
  if (material === 'flat') return 'none';
  if (material === 'paper') {
    const grain = colorWithAlpha(text.slice(0, 7), 8);
    return `repeating-linear-gradient(8deg, transparent 0 5px, ${grain} 5.5px, transparent 6px)`;
  }
  if (material === 'matte') return `linear-gradient(138deg, #ffffff0a, transparent 45%, ${colorWithAlpha(text.slice(0, 7), 4)})`;
  const glint = colorWithAlpha('#ffffff', Math.round((0.24 + intensity) * 255));
  return `linear-gradient(135deg, ${glint}, transparent 43%, #ffffff08 65%, #ffffff35)`;
}

function assetUrl(manifest: SkinManifest, assetId: string): string {
  return `url('/api/skins/${encodeURIComponent(skinVersionKey(manifest))}/assets/${encodeURIComponent(assetId)}')`;
}

function backgroundPattern(pattern: 'none' | 'dots' | 'grid' | 'fibers' | 'wash', accent: string, opacity: number): string {
  const mixed = colorWithAlpha(accent, Math.round(opacity * 255));
  if (pattern === 'dots') return `radial-gradient(circle, ${mixed} 1px, transparent 1.2px)`;
  if (pattern === 'grid') return `linear-gradient(${mixed} 1px, transparent 1px),linear-gradient(90deg,${mixed} 1px,transparent 1px)`;
  if (pattern === 'fibers') return `repeating-linear-gradient(7deg, transparent 0 13px, ${mixed} 14px, transparent 15px)`;
  if (pattern === 'wash') return `radial-gradient(circle at 22% 18%, ${mixed}, transparent 34%),radial-gradient(circle at 78% 76%, ${mixed}, transparent 31%)`;
  return 'none';
}

function colorWithAlpha(color: string, alpha: number): string {
  if (/^#[0-9a-f]{6}$/i.test(color)) return `${color}${Math.max(0, Math.min(255, alpha)).toString(16).padStart(2, '0')}`;
  return color;
}
