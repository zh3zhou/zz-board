import { z } from 'zod';
import { officialSkinRecipes } from './officialSkinRecipes.js';

export const SKIN_PACKAGE_FORMAT = 'zz-board-skin';
export const SKIN_PACKAGE_SCHEMA_VERSION = 3;
export const DEFAULT_SKIN_KEY = 'ink-constellation@3.0.0';
export const DEFAULT_LIGHT_SKIN_KEY = 'archive-paper@3.0.0';
export const LEGACY_SKIN_KEY = 'ink-constellation@2.0.0';
export const MAX_SKIN_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_SKIN_ASSET_DIMENSION = 4_096;
export const MAX_SKIN_PACKAGE_BYTES = 20 * 1024 * 1024;

const boundedText = (max: number) => z.string().trim().min(1).max(max);
const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const assetIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/);
const semanticVersion = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/);
const finiteRange = (minimum: number, maximum: number) => z.number().finite().min(minimum).max(maximum);

export const skinComponentIdSchema = z.enum(['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette']);
export type SkinComponentId = z.infer<typeof skinComponentIdSchema>;

const sourceAssetSchema = z
  .object({
    id: assetIdentifier,
    file: z.string().regex(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp)$/i),
    mediaType: z.enum(['image/png', 'image/webp'])
  })
  .strict();

const texturedSurfaceSchema = z
  .object({
    fill: color,
    text: color,
    border: color,
    accent: color,
    shadow: color,
    radius: finiteRange(0, 96),
    opacity: finiteRange(0.1, 1),
    textureAssetId: assetIdentifier.optional()
  })
  .strict();

export const skinShapeKindSchema = z.enum(['circle', 'ellipse', 'roundedRect', 'softBlob']);
export type SkinShapeKind = z.infer<typeof skinShapeKindSchema>;

const cornerRadiiSchema = z.tuple([
  finiteRange(0, 100), finiteRange(0, 100), finiteRange(0, 100), finiteRange(0, 100),
  finiteRange(0, 100), finiteRange(0, 100), finiteRange(0, 100), finiteRange(0, 100)
]);

const skinShapeSchema = z.object({
  kind: skinShapeKindSchema,
  cornerRadii: cornerRadiiSchema.optional(),
  aspectLockedDefault: z.boolean()
}).strict().superRefine((shape, context) => {
  if (shape.cornerRadii && shape.kind !== 'softBlob') {
    context.addIssue({ code: 'custom', path: ['cornerRadii'], message: 'Custom corner radii are only allowed for softBlob shapes.' });
  }
});

const materialSchema = z.enum(['flat', 'matte', 'paper', 'glass']);

const texturedSurfaceV2Schema = z.object({
  fill: color,
  text: color,
  border: color,
  accent: color,
  shadow: color,
  opacity: finiteRange(0.1, 1),
  textureAssetId: assetIdentifier.optional(),
  shape: skinShapeSchema,
  material: materialSchema,
  borderStrength: finiteRange(0, 1),
  elevation: z.number().int().min(0).max(4),
  highlightIntensity: finiteRange(0, 0.45)
}).strict();

const chromeComponentSchema = z.object({
  mode: z.enum(['light', 'dark']),
  panel: color,
  panelElevated: color,
  text: color,
  muted: color,
  border: color,
  accent: color,
  accentSoft: color,
  danger: color,
  material: materialSchema,
  borderStrength: finiteRange(0, 1),
  elevation: z.number().int().min(0).max(4),
  highlightIntensity: finiteRange(0, 0.45),
  radius: finiteRange(0, 32)
}).strict();

const backgroundComponentSchema = z
  .object({
    surface: color,
    accent: color,
    pattern: z.enum(['none', 'dots', 'grid', 'fibers', 'wash']),
    patternOpacity: finiteRange(0, 0.6),
    textureAssetId: assetIdentifier.optional(),
    textureOpacity: finiteRange(0, 1).default(0)
  })
  .strict();

const linkComponentSchema = z
  .object({
    color,
    highlight: color,
    width: finiteRange(0.5, 8),
    style: z.enum(['solid', 'dashed', 'dotted']),
    opacity: finiteRange(0.1, 1)
  })
  .strict();

const inkPaletteComponentSchema = z
  .object({
    colors: z.array(color).min(1).max(12),
    widths: z.array(finiteRange(0.5, 48)).min(1).max(8),
    highlighterOpacity: finiteRange(0.05, 0.8),
    selection: color
  })
  .strict();

const motionSchema = z
  .object({
    kind: z.enum(['none', 'drift', 'breathe']),
    durationMs: z.number().int().min(4_000).max(30_000),
    amplitudePx: finiteRange(0, 18),
    shadowPulse: finiteRange(0, 0.35)
  })
  .strict();

const skinManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    skinId: identifier,
    version: semanticVersion,
    displayName: boundedText(80),
    description: boundedText(400),
    components: z
      .object({
        background: backgroundComponentSchema.optional(),
        taskBubble: texturedSurfaceSchema.optional(),
        note: texturedSurfaceSchema.optional(),
        link: linkComponentSchema.optional(),
        inkPalette: inkPaletteComponentSchema.optional()
      })
      .strict()
      .refine((components) => Object.values(components).some(Boolean), 'A Skin must define at least one component.'),
    motion: motionSchema.optional(),
    assets: z.array(sourceAssetSchema).max(48).default([])
  })
  .strict()
  .superRefine(validateManifestAssets);

const skinManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  skinId: identifier,
  version: semanticVersion,
  displayName: boundedText(80),
  description: boundedText(400),
  components: z.object({
    background: backgroundComponentSchema.optional(),
    chrome: chromeComponentSchema.optional(),
    taskBubble: texturedSurfaceV2Schema.optional(),
    note: texturedSurfaceV2Schema.optional(),
    link: linkComponentSchema.optional(),
    inkPalette: inkPaletteComponentSchema.optional()
  }).strict().refine((components) => Object.values(components).some(Boolean), 'A Skin must define at least one component.'),
  motion: motionSchema.optional(),
  assets: z.array(sourceAssetSchema).max(48).default([])
}).strict().superRefine((manifest, context) => {
  validateManifestAssets(manifest, context);
  validateV2Contrast(manifest, context);
});

const opaqueColor = z.string().regex(/^#[0-9a-f]{6}$/i);
const foundationSchema = z.object({
  paper: opaqueColor, text: opaqueColor, accent: opaqueColor,
  priority: z.object({ attention: opaqueColor, high: opaqueColor }).strict(),
  material: materialSchema
}).strict();

const skinManifestV3Schema = z.object({
  schemaVersion: z.literal(3),
  skinId: identifier,
  version: semanticVersion,
  displayName: boundedText(80),
  description: boundedText(400),
  foundation: foundationSchema,
  components: z.object({
    background: backgroundComponentSchema.extend({ textureOpacity: finiteRange(0, 1) }).partial().optional(),
    chrome: chromeComponentSchema.partial().optional(),
    taskBubble: texturedSurfaceV2Schema.partial().optional(),
    note: texturedSurfaceV2Schema.partial().optional(),
    link: linkComponentSchema.partial().optional(),
    inkPalette: inkPaletteComponentSchema.extend({ colors: z.array(opaqueColor).min(1).max(12) }).partial().optional()
  }).strict().optional(),
  motion: motionSchema.optional(),
  assets: z.array(sourceAssetSchema).max(48).default([])
}).strict().superRefine((manifest, context) => {
  const components = resolveRecipe(manifest);
  validateManifestAssets({ components, assets: manifest.assets }, context);
  // A transparent label or very faint surface can otherwise pass hex-only contrast checks.
  const background = compositeColor(components.background.surface, manifest.foundation.paper);
  const panel = compositeColor(components.chrome.panel, background);
  for (const [field, minimum] of [['text', 4.5], ['muted', 3], ['border', 1.35]] as const) {
    if (contrastRatio(compositeColor(components.chrome[field], panel), panel) < minimum) {
      context.addIssue({ code: 'custom', path: ['components', 'chrome', field], message: 'Insufficient visible chrome contrast.' });
    }
  }
  for (const id of ['taskBubble', 'note'] as const) {
    const surface = components[id];
    const fill = compositeColor(surface.fill, background);
    const visibleFill = mixColor(background, fill, surface.opacity);
    const visibleText = mixColor(background, compositeColor(surface.text, fill), surface.opacity);
    if (contrastRatio(visibleText, visibleFill) < 4.5) {
      context.addIssue({ code: 'custom', path: ['components', id, 'text'], message: 'Visible surface text contrast must be at least 4.5:1.' });
    }
  }
  if (manifest.foundation.priority.attention.toLowerCase() === manifest.foundation.priority.high.toLowerCase()) {
    context.addIssue({ code: 'custom', path: ['foundation', 'priority'], message: 'Choose distinct colors for the two priority levels.' });
  }
});

export const skinManifestSchema = z.discriminatedUnion('schemaVersion', [skinManifestV1Schema, skinManifestV2Schema, skinManifestV3Schema]);

type ManifestAssetShape = {
  assets: Array<{ id: string; file: string }>;
  components: object;
};

function validateManifestAssets(manifest: ManifestAssetShape, context: z.RefinementCtx): void {
  const assetIds = new Set<string>();
  const assetFiles = new Set<string>();
  for (const [index, asset] of manifest.assets.entries()) {
    if (assetIds.has(asset.id)) context.addIssue({ code: 'custom', path: ['assets', index, 'id'], message: 'Duplicate asset id.' });
    if (assetFiles.has(asset.file.toLowerCase())) context.addIssue({ code: 'custom', path: ['assets', index, 'file'], message: 'Duplicate asset file.' });
    assetIds.add(asset.id);
    assetFiles.add(asset.file.toLowerCase());
  }
  for (const [componentId, component] of Object.entries(manifest.components)) {
    if (!component || typeof component !== 'object' || !('textureAssetId' in component) || !component.textureAssetId) continue;
    if (!assetIds.has(String(component.textureAssetId))) {
      context.addIssue({ code: 'custom', path: ['components', componentId, 'textureAssetId'], message: `Unknown texture asset: ${String(component.textureAssetId)}` });
    }
  }
}

type ContrastManifestShape = {
  components: {
    background?: { surface: string };
    chrome?: { panel: string; text: string; muted: string; border: string; accent: string };
    taskBubble?: { fill: string; text: string };
    note?: { fill: string; text: string };
  };
};

function validateV2Contrast(manifest: ContrastManifestShape, context: z.RefinementCtx): void {
  const background = manifest.components.background?.surface || '#FFFFFF';
  const checks: Array<{ path: string[]; foreground: string; surface: string; minimum: number; message: string }> = [];
  const chrome = manifest.components.chrome;
  if (chrome) {
    checks.push(
      { path: ['components', 'chrome', 'text'], foreground: chrome.text, surface: chrome.panel, minimum: 4.5, message: 'Chrome text contrast must be at least 4.5:1.' },
      { path: ['components', 'chrome', 'muted'], foreground: chrome.muted, surface: chrome.panel, minimum: 3, message: 'Chrome secondary text contrast must be at least 3:1.' },
      { path: ['components', 'chrome', 'border'], foreground: chrome.border, surface: chrome.panel, minimum: 1.35, message: 'Chrome interaction boundary contrast must be at least 1.35:1.' }
    );
  }
  for (const componentId of ['taskBubble', 'note'] as const) {
    const component = manifest.components[componentId];
    if (!component) continue;
    checks.push({ path: ['components', componentId, 'text'], foreground: component.text, surface: compositeColor(component.fill, background), minimum: 4.5, message: `${componentId} text contrast must be at least 4.5:1.` });
  }
  for (const check of checks) {
    if (contrastRatio(check.foreground, check.surface) < check.minimum) {
      context.addIssue({ code: 'custom', path: check.path, message: check.message });
    }
  }
}

export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function compositeColor(foreground: string, background: string): string {
  if (foreground.length !== 9) return foreground;
  const alpha = Number.parseInt(foreground.slice(7, 9), 16) / 255;
  return mixColor(background, foreground, alpha);
}

function mixColor(base: string, tint: string, weight: number): string {
  const to = hexRgb(tint);
  const channels = hexRgb(base).map((from, index) => Math.round(from * (1 - weight) + to[index]! * weight));
  return '#' + channels.map((value) => value.toString(16).padStart(2, '0')).join('');
}

function relativeLuminance(value: string): number {
  const [red, green, blue] = hexRgb(value).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function hexRgb(value: string): [number, number, number] {
  return [Number.parseInt(value.slice(1, 3), 16), Number.parseInt(value.slice(3, 5), 16), Number.parseInt(value.slice(5, 7), 16)];
}

export const skinProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: boundedText(80),
    source: z.enum(['original', 'generated', 'adapted']),
    referenceUsed: z.boolean(),
    referencePolicy: z.literal('original-reference-not-included'),
    generatedWith: z.array(boundedText(120)).max(12).default([]),
    notes: z.string().trim().max(1_000).default('')
  })
  .strict();

const packagedAssetSchema = z
  .object({
    id: assetIdentifier,
    file: z.string().regex(/^assets\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:png|webp)$/i),
    mediaType: z.enum(['image/png', 'image/webp']),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive().max(MAX_SKIN_ASSET_BYTES),
    width: z.number().int().positive().max(MAX_SKIN_ASSET_DIMENSION),
    height: z.number().int().positive().max(MAX_SKIN_ASSET_DIMENSION),
    dataBase64: z.string().min(4)
  })
  .strict();

const skinPackageV1Schema = z.object({
    format: z.literal(SKIN_PACKAGE_FORMAT),
    schemaVersion: z.literal(1),
    manifest: skinManifestV1Schema,
    styleBrief: z.string().trim().min(1).max(20_000),
    provenance: skinProvenanceSchema,
    assets: z.array(packagedAssetSchema).max(48)
  }).strict();

const skinPackageV2Schema = z.object({
  format: z.literal(SKIN_PACKAGE_FORMAT),
  schemaVersion: z.literal(2),
  manifest: skinManifestV2Schema,
  styleBrief: z.string().trim().min(1).max(20_000),
  provenance: skinProvenanceSchema,
  assets: z.array(packagedAssetSchema).max(48)
}).strict();

const skinPackageV3Schema = skinPackageV2Schema.extend({ schemaVersion: z.literal(3), manifest: skinManifestV3Schema });

export const skinPackageSchema = z.discriminatedUnion('schemaVersion', [skinPackageV1Schema, skinPackageV2Schema, skinPackageV3Schema]);

export type SkinManifest = z.infer<typeof skinManifestSchema>;
export type SkinPackage = z.infer<typeof skinPackageSchema>;
export type SkinProvenance = z.infer<typeof skinProvenanceSchema>;
type SkinManifestV1 = z.infer<typeof skinManifestV1Schema>;
type SkinManifestV2 = z.infer<typeof skinManifestV2Schema>;
export type SkinManifestV3 = z.infer<typeof skinManifestV3Schema>;
type SkinComponentsV1 = SkinManifestV1['components'];
type SkinComponentsV2 = SkinManifestV2['components'];
export type SkinComponent = NonNullable<SkinComponentsV1[keyof SkinComponentsV1] | SkinComponentsV2[keyof SkinComponentsV2]>;
export type SkinSurface = NonNullable<SkinComponentsV1['taskBubble'] | SkinComponentsV2['taskBubble']>;

/** V3 packages store the authored foundation and sparse overrides. Only consumers need the six resolved components. */
function resolveRecipe(manifest: SkinManifestV3): Required<SkinComponentsV2> {
  const { paper, text, accent, material, priority } = manifest.foundation;
  const overrides = manifest.components;
  const dark = relativeLuminance(paper) < relativeLuminance(text);
  const edge = mixColor(paper, text, 0.46);
  const sheet = mixColor(paper, '#ffffff', dark ? 0.075 : 0.35);
  const surface = {
    fill: sheet, text, accent, border: edge, material, opacity: 1,
    shadow: dark ? '#05060988' : '#332b222b', borderStrength: 0.5,
    elevation: 1, highlightIntensity: material === 'glass' ? 0.16 : 0.04
  };
  return {
    background: {
      surface: paper, accent, pattern: 'none', patternOpacity: 0.12, textureOpacity: 0,
      ...overrides?.background
    },
    chrome: {
      mode: dark ? 'dark' : 'light', material, panel: sheet, panelElevated: mixColor(sheet, '#ffffff', dark ? 0.055 : 0.48),
      text, muted: mixColor(sheet, text, 0.73), border: edge, accent, accentSoft: mixColor(sheet, accent, 0.16),
      danger: dark ? '#FFA69A' : '#993F39', radius: 12, borderStrength: 0.5, elevation: 1, highlightIntensity: surface.highlightIntensity,
      ...overrides?.chrome
    },
    taskBubble: { ...surface, shape: { kind: 'circle', aspectLockedDefault: true }, ...overrides?.taskBubble },
    note: {
      ...surface, fill: mixColor(sheet, accent, 0.045), shape: { kind: 'roundedRect', aspectLockedDefault: false },
      ...overrides?.note
    },
    link: { color: mixColor(accent, text, 0.28), highlight: accent, width: 1.8, style: 'solid', opacity: 0.8, ...overrides?.link },
    inkPalette: { colors: [text, accent, priority.attention, priority.high], widths: [2, 4, 8, 16], highlighterOpacity: 0.24, selection: accent, ...overrides?.inkPalette }
  };
}

const recipeCache = new WeakMap<SkinManifestV3, Required<SkinComponentsV2>>();

export interface UnpackedSkinPackage {
  package: SkinPackage;
  assets: ReadonlyMap<string, Uint8Array>;
}

export function skinVersionKey(skin: Pick<SkinManifest, 'skinId' | 'version'>): string {
  return `${skin.skinId}@${skin.version}`;
}

export function createSkinReference(skin: Pick<SkinManifest, 'skinId' | 'version'>, componentId: SkinComponentId): string {
  return `${skinVersionKey(skin)}/${componentId}`;
}

export function getSkinComponent(manifest: SkinManifest, componentId: SkinComponentId): SkinComponent | undefined {
  if (manifest.schemaVersion === 3) {
    const cached = recipeCache.get(manifest);
    if (cached) return cached[componentId];
    const components = resolveRecipe(manifest);
    recipeCache.set(manifest, components);
    return components[componentId];
  }
  return (manifest.components as Partial<Record<SkinComponentId, SkinComponent>>)[componentId];
}

export function skinComponentIds(manifest: SkinManifest): SkinComponentId[] {
  return skinComponentIdSchema.options.filter((id) => Boolean(getSkinComponent(manifest, id)));
}

export function parseSkinReference(reference: string): { skinId: string; version: string; componentId: SkinComponentId } {
  const match = /^([a-z0-9][a-z0-9-]{0,63})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/(background|chrome|taskBubble|note|link|inkPalette)$/.exec(reference);
  if (!match) throw new Error(`Invalid pinned Skin component reference: ${reference}`);
  return { skinId: match[1]!, version: match[2]!, componentId: skinComponentIdSchema.parse(match[3]) };
}

export function parseSkinManifest(input: unknown): SkinManifest {
  return skinManifestSchema.parse(input);
}

export async function packSkin(
  manifestInput: unknown,
  sourceAssets: ReadonlyMap<string, Uint8Array>,
  styleBrief: string,
  provenanceInput: unknown
): Promise<SkinPackage> {
  const manifest = skinManifestSchema.parse(manifestInput);
  const provenance = skinProvenanceSchema.parse(provenanceInput);
  const declaredIds = new Set(manifest.assets.map((asset) => asset.id));
  for (const id of sourceAssets.keys()) {
    if (!declaredIds.has(id)) throw new Error(`Undeclared Skin asset: ${id}`);
  }
  const assets = [];
  for (const asset of manifest.assets) {
    const bytes = sourceAssets.get(asset.id);
    if (!bytes) throw new Error(`Missing Skin asset: ${asset.id}`);
    const inspected = inspectImage(bytes);
    if (inspected.mediaType !== asset.mediaType) throw new Error(`Asset media type does not match its content: ${asset.id}`);
    assets.push({
      ...asset,
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      width: inspected.width,
      height: inspected.height,
      dataBase64: encodeBase64(bytes)
    });
  }
  const skinPackage = skinPackageSchema.parse({
    format: SKIN_PACKAGE_FORMAT,
    schemaVersion: manifest.schemaVersion,
    manifest,
    styleBrief,
    provenance,
    assets
  });
  enforcePackageSize(skinPackage);
  return skinPackage;
}

export async function validateSkinPackage(input: unknown): Promise<SkinPackage> {
  const skinPackage = skinPackageSchema.parse(input);
  enforcePackageSize(skinPackage);
  const declarations = new Map(skinPackage.manifest.assets.map((asset) => [asset.id, asset]));
  if (declarations.size !== skinPackage.assets.length) throw new Error('Skin asset declarations and packaged assets differ.');
  const seen = new Set<string>();
  let totalAssetBytes = 0;
  for (const packaged of skinPackage.assets) {
    if (seen.has(packaged.id)) throw new Error(`Duplicate packaged Skin asset: ${packaged.id}`);
    seen.add(packaged.id);
    const declaration = declarations.get(packaged.id);
    if (!declaration || declaration.file !== packaged.file || declaration.mediaType !== packaged.mediaType) {
      throw new Error(`Packaged Skin asset does not match its declaration: ${packaged.id}`);
    }
    const bytes = decodeBase64(packaged.dataBase64);
    if (bytes.byteLength !== packaged.bytes) throw new Error(`Skin asset byte count mismatch: ${packaged.id}`);
    totalAssetBytes += bytes.byteLength;
    if (totalAssetBytes > MAX_SKIN_PACKAGE_BYTES) throw new Error('Skin assets exceed the package size limit.');
    const image = inspectImage(bytes);
    if (image.mediaType !== packaged.mediaType || image.width !== packaged.width || image.height !== packaged.height) {
      throw new Error(`Skin asset image metadata mismatch: ${packaged.id}`);
    }
    if ((await sha256Hex(bytes)) !== packaged.sha256) throw new Error(`Skin asset digest mismatch: ${packaged.id}`);
  }
  return skinPackage;
}

export async function unpackSkinPackage(input: unknown): Promise<UnpackedSkinPackage> {
  const skinPackage = await validateSkinPackage(input);
  return {
    package: skinPackage,
    assets: new Map(skinPackage.assets.map((asset) => [asset.id, decodeBase64(asset.dataBase64)]))
  };
}

export function serializeSkinPackage(input: unknown): string {
  const skinPackage = skinPackageSchema.parse(input);
  enforcePackageSize(skinPackage);
  return `${JSON.stringify(skinPackage, null, 2)}\n`;
}

export function inspectImage(bytes: Uint8Array): { mediaType: 'image/png' | 'image/webp'; width: number; height: number } {
  if (bytes.byteLength > MAX_SKIN_ASSET_BYTES) throw new Error(`Skin asset exceeds ${MAX_SKIN_ASSET_BYTES} bytes.`);
  if (isPng(bytes)) {
    validatePngEnvelope(bytes);
    return checkedDimensions('image/png', readU32Be(bytes, 16), readU32Be(bytes, 20));
  }
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') throw new Error('Skin assets must be PNG or WebP images.');
  if (bytes.byteLength < 20 || readU32Le(bytes, 4) + 8 !== bytes.byteLength) throw new Error('Malformed WebP container.');
  const chunk = ascii(bytes, 12, 16);
  if (chunk === 'VP8X' && bytes.byteLength >= 30) {
    if ((bytes[20]! & 0x02) !== 0) throw new Error('Animated WebP is not allowed in a Skin.');
    return checkedDimensions('image/webp', 1 + readU24Le(bytes, 24), 1 + readU24Le(bytes, 27));
  }
  if (chunk === 'VP8L' && bytes.byteLength >= 25 && bytes[20] === 0x2f) {
    const bits = readU32Le(bytes, 21);
    return checkedDimensions('image/webp', 1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
  }
  if (chunk === 'VP8 ' && bytes.byteLength >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return checkedDimensions('image/webp', readU16Le(bytes, 26) & 0x3fff, readU16Le(bytes, 28) & 0x3fff);
  }
  throw new Error('Unsupported or malformed WebP image.');
}

function checkedDimensions(mediaType: 'image/png' | 'image/webp', width: number, height: number) {
  if (width < 1 || height < 1 || width > MAX_SKIN_ASSET_DIMENSION || height > MAX_SKIN_ASSET_DIMENSION) {
    throw new Error(`Skin image dimensions must be between 1 and ${MAX_SKIN_ASSET_DIMENSION} pixels.`);
  }
  return { mediaType, width, height };
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 33
    && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)
    && readU32Be(bytes, 8) === 13
    && ascii(bytes, 12, 16) === 'IHDR';
}

function validatePngEnvelope(bytes: Uint8Array): void {
  let offset = 8;
  let chunks = 0;
  while (offset + 12 <= bytes.byteLength && chunks < 10_000) {
    const dataLength = readU32Be(bytes, offset);
    const type = ascii(bytes, offset + 4, offset + 8);
    const end = offset + 12 + dataLength;
    if (end > bytes.byteLength) throw new Error('Malformed PNG chunk length.');
    if (type === 'acTL') throw new Error('Animated PNG is not allowed in a Skin.');
    if (type === 'IEND') {
      if (dataLength !== 0 || end !== bytes.byteLength) throw new Error('Malformed PNG ending.');
      return;
    }
    offset = end;
    chunks += 1;
  }
  throw new Error('Malformed PNG container.');
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.slice(start, end));
}

function readU16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function readU32Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function readU32Be(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = Uint8Array.from(bytes);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', copy));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkSize)));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Skin asset has invalid Base64 data.');
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('Skin asset has invalid Base64 data.');
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function enforcePackageSize(skinPackage: SkinPackage): void {
  const bytes = new TextEncoder().encode(JSON.stringify(skinPackage)).byteLength;
  if (bytes > MAX_SKIN_PACKAGE_BYTES) throw new Error(`Skin package exceeds ${MAX_SKIN_PACKAGE_BYTES} bytes.`);
}

const neutralProvenance: SkinProvenance = {
  schemaVersion: 1,
  createdAt: '2026-09-04T00:00:00.000Z',
  source: 'original',
  referenceUsed: false,
  referencePolicy: 'original-reference-not-included',
  generatedWith: [],
  notes: 'Built into ZZ Board.'
};

function builtin(manifest: SkinManifest, styleBrief: string): SkinPackage {
  return skinPackageSchema.parse({
    format: SKIN_PACKAGE_FORMAT,
    schemaVersion: manifest.schemaVersion,
    manifest,
    styleBrief,
    provenance: neutralProvenance,
    assets: []
  });
}

export const BUILT_IN_SKINS: readonly SkinPackage[] = [
  builtin({
    schemaVersion: 1,
    skinId: 'archive-paper', version: '1.0.0', displayName: '档案纸', description: '温暖纸张、钢笔墨色与克制纤维。', assets: [],
    components: {
      background: { surface: '#E9E0CE', accent: '#9A6C45', pattern: 'fibers', patternOpacity: 0.16, textureOpacity: 0 },
      taskBubble: { fill: '#F6F0E4E8', text: '#342D29', border: '#9B7D63', accent: '#A55C36', shadow: '#6B4E3B40', radius: 44, opacity: 0.96 },
      note: { fill: '#F3DFA8F2', text: '#3B3126', border: '#B18B4F', accent: '#C9783D', shadow: '#6B4E3B35', radius: 10, opacity: 0.97 },
      link: { color: '#765F52', highlight: '#C2673F', width: 2, style: 'solid', opacity: 0.72 },
      inkPalette: { colors: ['#342D29', '#A55C36', '#3F6C68', '#735B8C'], widths: [2, 4, 8, 16], highlighterOpacity: 0.26, selection: '#C2673F' }
    },
    motion: { kind: 'drift', durationMs: 14_000, amplitudePx: 8, shadowPulse: 0.12 }
  }, '像一张可以长期摆在桌上的中性档案纸。'),
  builtin({
    schemaVersion: 1,
    skinId: 'ink-constellation', version: '1.0.0', displayName: '墨色星群', description: '深色空间、薄雾光晕与冷色连线。', assets: [],
    components: {
      background: { surface: '#11141D', accent: '#6687B8', pattern: 'dots', patternOpacity: 0.18, textureOpacity: 0 },
      taskBubble: { fill: '#1B2332E8', text: '#E7EDF7', border: '#61799A', accent: '#8BA9D4', shadow: '#07101CCC', radius: 52, opacity: 0.92 },
      note: { fill: '#303A4BEE', text: '#F1F4FA', border: '#72839C', accent: '#D7B36A', shadow: '#050913A8', radius: 14, opacity: 0.96 },
      link: { color: '#7894BC', highlight: '#C6DBFF', width: 1.8, style: 'solid', opacity: 0.76 },
      inkPalette: { colors: ['#E7EDF7', '#8BA9D4', '#D7B36A', '#E38C9E'], widths: [2, 4, 8, 16], highlighterOpacity: 0.22, selection: '#C6DBFF' }
    },
    motion: { kind: 'breathe', durationMs: 12_000, amplitudePx: 7, shadowPulse: 0.18 }
  }, '静谧的深色画布，任务像近处可触的星点。'),
  builtin({
    schemaVersion: 1,
    skinId: 'glass-drift', version: '1.0.0', displayName: '流光玻璃', description: '清凉玻璃面、柔和蓝绿流光与低密度网格。', assets: [],
    components: {
      background: { surface: '#DDECF2', accent: '#4C9DA0', pattern: 'grid', patternOpacity: 0.1, textureOpacity: 0 },
      taskBubble: { fill: '#FFFFFFB8', text: '#17343A', border: '#72A9AD', accent: '#3C9294', shadow: '#39767A38', radius: 56, opacity: 0.82 },
      note: { fill: '#E9FFF5D9', text: '#1E3E3A', border: '#73A99A', accent: '#EF9D6F', shadow: '#39767A30', radius: 18, opacity: 0.9 },
      link: { color: '#4A8F93', highlight: '#E77D54', width: 2, style: 'dashed', opacity: 0.68 },
      inkPalette: { colors: ['#17343A', '#3C9294', '#E77D54', '#6B61A8'], widths: [2, 5, 10, 18], highlighterOpacity: 0.2, selection: '#E77D54' }
    },
    motion: { kind: 'drift', durationMs: 16_000, amplitudePx: 11, shadowPulse: 0.14 }
  }, '像早晨窗边的薄玻璃，透气但不失聚焦。'),
  builtin({
    schemaVersion: 1,
    skinId: 'sketch-collage', version: '1.0.0', displayName: '手绘拼贴', description: '素描边线、剪贴色块和有层次的手账感。', assets: [],
    components: {
      background: { surface: '#F3EFE6', accent: '#5E7789', pattern: 'wash', patternOpacity: 0.12, textureOpacity: 0 },
      taskBubble: { fill: '#FFFDF5F2', text: '#2E3034', border: '#4C5258', accent: '#D66B54', shadow: '#4A45402F', radius: 30, opacity: 0.97 },
      note: { fill: '#F4D675F0', text: '#353027', border: '#695C42', accent: '#5D8796', shadow: '#4A45402A', radius: 5, opacity: 0.95 },
      link: { color: '#59636A', highlight: '#D66B54', width: 2.4, style: 'dotted', opacity: 0.8 },
      inkPalette: { colors: ['#2E3034', '#D66B54', '#5D8796', '#8A6DA3'], widths: [1.5, 3, 7, 14], highlighterOpacity: 0.28, selection: '#D66B54' }
    },
    motion: { kind: 'drift', durationMs: 15_000, amplitudePx: 6, shadowPulse: 0.08 }
  }, '用素描本与剪贴纸的语言，给自由写画留出舒服的位置。')
  ,
  builtin({
    schemaVersion: 2,
    skinId: 'ink-constellation', version: '2.0.0', displayName: '夜墨 2.0', description: '近黑石墨、暖灰文字与低饱和铜色，安静而有分量。', assets: [],
    components: {
      background: { surface: '#151514', accent: '#8A765F', pattern: 'dots', patternOpacity: 0.08, textureOpacity: 0 },
      chrome: { mode: 'dark', panel: '#1D1D1B', panelElevated: '#252420', text: '#E9E4DA', muted: '#B9B0A2', border: '#625A4F', accent: '#B28A5C', accentSoft: '#3A3025', danger: '#D37B70', material: 'matte', borderStrength: 0.48, elevation: 2, highlightIntensity: 0.05, radius: 14 },
      taskBubble: { fill: '#272521F2', text: '#F0EAE0', border: '#756A5B', accent: '#B28A5C', shadow: '#050504B8', opacity: 0.96, shape: { kind: 'circle', aspectLockedDefault: true }, material: 'matte', borderStrength: 0.52, elevation: 2, highlightIntensity: 0.04 },
      note: { fill: '#312E29F2', text: '#F0EAE0', border: '#766B5D', accent: '#B28A5C', shadow: '#050504A8', opacity: 0.98, shape: { kind: 'roundedRect', aspectLockedDefault: false }, material: 'paper', borderStrength: 0.46, elevation: 1, highlightIntensity: 0.03 },
      link: { color: '#857764', highlight: '#D1A46F', width: 1.7, style: 'solid', opacity: 0.7 },
      inkPalette: { colors: ['#E9E4DA', '#B28A5C', '#8FA09B', '#B77B79'], widths: [2, 4, 8, 16], highlighterOpacity: 0.2, selection: '#D1A46F' }
    },
    motion: { kind: 'drift', durationMs: 17_000, amplitudePx: 6, shadowPulse: 0.07 }
  }, '像一张压低反光的石墨桌面：铜色只负责引路，内容保持安静。'),
  builtin({
    schemaVersion: 2,
    skinId: 'archive-paper', version: '2.0.0', displayName: '静纸 2.0', description: '克制的浅纸、清晰墨色与少量棕灰层次。', assets: [],
    components: {
      background: { surface: '#EDE8DE', accent: '#8A7966', pattern: 'fibers', patternOpacity: 0.08, textureOpacity: 0 },
      chrome: { mode: 'light', panel: '#F7F3EB', panelElevated: '#FCFAF5', text: '#292620', muted: '#686158', border: '#A69D90', accent: '#73583A', accentSoft: '#E8DDCB', danger: '#99463D', material: 'paper', borderStrength: 0.42, elevation: 1, highlightIntensity: 0.04, radius: 12 },
      taskBubble: { fill: '#F8F5EEF5', text: '#2A2722', border: '#948575', accent: '#795D40', shadow: '#4B403326', opacity: 0.98, shape: { kind: 'circle', aspectLockedDefault: true }, material: 'paper', borderStrength: 0.4, elevation: 1, highlightIntensity: 0.02 },
      note: { fill: '#E7D8BDF5', text: '#2D2922', border: '#9A8565', accent: '#8A593B', shadow: '#4B403322', opacity: 0.98, shape: { kind: 'roundedRect', aspectLockedDefault: false }, material: 'paper', borderStrength: 0.4, elevation: 1, highlightIntensity: 0.02 },
      link: { color: '#746A5D', highlight: '#8A593B', width: 1.7, style: 'solid', opacity: 0.66 },
      inkPalette: { colors: ['#2A2722', '#795D40', '#4E6C69', '#755F78'], widths: [2, 4, 8, 16], highlighterOpacity: 0.22, selection: '#8A593B' }
    },
    motion: { kind: 'drift', durationMs: 18_000, amplitudePx: 5, shadowPulse: 0.04 }
  }, '安静的纸面系统，以清楚、耐看和长期阅读为先。'),
  builtin({
    schemaVersion: 2,
    skinId: 'glass-drift', version: '2.0.0', displayName: '流光玻璃 2.0', description: '低饱和雾面玻璃，保留通透感但克制装饰。', assets: [],
    components: {
      background: { surface: '#DDE4E5', accent: '#648B8A', pattern: 'grid', patternOpacity: 0.055, textureOpacity: 0 },
      chrome: { mode: 'light', panel: '#EEF3F1F2', panelElevated: '#F8FAF9F2', text: '#1D3030', muted: '#576A69', border: '#829A98', accent: '#3F7472', accentSoft: '#D2E3E0', danger: '#984C48', material: 'glass', borderStrength: 0.38, elevation: 2, highlightIntensity: 0.12, radius: 16 },
      taskBubble: { fill: '#F4F8F6E8', text: '#193130', border: '#779997', accent: '#3F7472', shadow: '#23484633', opacity: 0.9, shape: { kind: 'ellipse', aspectLockedDefault: false }, material: 'glass', borderStrength: 0.36, elevation: 2, highlightIntensity: 0.1 },
      note: { fill: '#E8F0EDE8', text: '#203130', border: '#809996', accent: '#8A654C', shadow: '#2348462B', opacity: 0.94, shape: { kind: 'roundedRect', aspectLockedDefault: false }, material: 'glass', borderStrength: 0.34, elevation: 1, highlightIntensity: 0.08 },
      link: { color: '#527B79', highlight: '#92664B', width: 1.8, style: 'solid', opacity: 0.62 },
      inkPalette: { colors: ['#193130', '#3F7472', '#92664B', '#665F86'], widths: [2, 5, 10, 18], highlighterOpacity: 0.18, selection: '#92664B' }
    },
    motion: { kind: 'drift', durationMs: 19_000, amplitudePx: 7, shadowPulse: 0.06 }
  }, '雾面玻璃与低密度结构线，轻但不发亮。'),
  builtin({
    schemaVersion: 2,
    skinId: 'sketch-collage', version: '2.0.0', displayName: '手绘拼贴 2.0', description: '自然纸面、柔软轮廓与成熟的手工痕迹。', assets: [],
    components: {
      background: { surface: '#E9E1D4', accent: '#6F7772', pattern: 'wash', patternOpacity: 0.075, textureOpacity: 0 },
      chrome: { mode: 'light', panel: '#F3EDE3', panelElevated: '#FAF6EF', text: '#2D2D2A', muted: '#686762', border: '#9B968D', accent: '#7A5646', accentSoft: '#E7D7C9', danger: '#9D4941', material: 'paper', borderStrength: 0.44, elevation: 1, highlightIntensity: 0.03, radius: 10 },
      taskBubble: { fill: '#F8F3E9F5', text: '#2C2D2B', border: '#77756F', accent: '#8B5C49', shadow: '#39373227', opacity: 0.97, shape: { kind: 'softBlob', cornerRadii: [58, 44, 62, 47, 48, 61, 43, 57], aspectLockedDefault: false }, material: 'paper', borderStrength: 0.46, elevation: 1, highlightIntensity: 0.02 },
      note: { fill: '#DCC99AF2', text: '#302D27', border: '#81745E', accent: '#55706D', shadow: '#39373224', opacity: 0.97, shape: { kind: 'softBlob', cornerRadii: [12, 8, 14, 9, 9, 13, 8, 12], aspectLockedDefault: false }, material: 'paper', borderStrength: 0.42, elevation: 1, highlightIntensity: 0.02 },
      link: { color: '#676964', highlight: '#8B5C49', width: 2, style: 'dotted', opacity: 0.68 },
      inkPalette: { colors: ['#2C2D2B', '#8B5C49', '#55706D', '#786484'], widths: [1.5, 3, 7, 14], highlighterOpacity: 0.24, selection: '#8B5C49' }
    },
    motion: { kind: 'drift', durationMs: 18_000, amplitudePx: 5, shadowPulse: 0.04 }
  }, '柔软、不规则但克制的纸张轮廓，避免玩具感。'),
  ...officialSkinRecipes.map((manifest) => builtin(manifest, manifest.description))
] as const;

export function builtInSkin(key: string): SkinPackage | undefined {
  return BUILT_IN_SKINS.find((skin) => skinVersionKey(skin.manifest) === key);
}
