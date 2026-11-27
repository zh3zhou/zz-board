import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILT_IN_SKINS,
  createSkinReference,
  getSkinComponent,
  packSkin,
  parseSkinManifest,
  parseSkinReference,
  serializeSkinPackage,
  skinComponentIds,
  unpackSkinPackage,
  validateSkinPackage,
  type SkinManifest
} from '../../src/shared/skin.js';
import { SkinLibrary } from '../../src/server/skinLibrary.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('declarative Skin package', () => {
  it('keeps all four official families in three independently pinned versions', () => {
    expect(BUILT_IN_SKINS.map((skin) => skin.manifest.skinId)).toEqual([
      'archive-paper', 'ink-constellation', 'glass-drift', 'sketch-collage',
      'ink-constellation', 'archive-paper', 'glass-drift', 'sketch-collage',
      'ink-constellation', 'archive-paper', 'glass-drift', 'sketch-collage'
    ]);
    expect(BUILT_IN_SKINS.filter((skin) => skin.schemaVersion === 2).map((skin) => skin.manifest.displayName)).toEqual([
      '夜墨 2.0', '静纸 2.0', '流光玻璃 2.0', '手绘拼贴 2.0'
    ]);
    expect(BUILT_IN_SKINS.filter((skin) => skin.schemaVersion === 3).map((skin) => skin.manifest.displayName)).toEqual(['夜墨', '静纸', '流光玻璃', '手绘拼贴']);
    for (const skin of BUILT_IN_SKINS) {
      expect(parseSkinManifest(skin.manifest)).toEqual(skin.manifest);
      expect(skin.assets).toEqual([]);
    }
  });

  it('round trips only the authored V3 recipe while resolving all six components and local textures', async () => {
    const paper = BUILT_IN_SKINS.find((skin) => skin.manifest.displayName === '静纸')!.manifest;
    if (paper.schemaVersion !== 3) throw new Error('Expected a V3 Skin');
    const bare = { ...paper, skinId: 'round-trip', components: undefined };
    const raw = { ...bare, components: { background: { textureAssetId: 'grain', textureOpacity: 0.22 }, note: { material: 'flat' } },
      assets: [{ id: 'grain', file: 'assets/grain.png', mediaType: 'image/png' }] };
    const packed = await packSkin(raw, new Map([['grain', png1x1()]]), '蓝墨样板', provenance());
    const unpacked = await unpackSkinPackage(JSON.parse(serializeSkinPackage(packed)));
    const manifest = unpacked.package.manifest;
    expect(manifest.components).toEqual(raw.components);
    expect(unpacked.assets.get('grain')).toEqual(png1x1());
    expect(skinComponentIds(manifest)).toEqual(['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette']);
    expect(getSkinComponent(manifest, 'note')).toMatchObject({ material: 'flat', text: paper.foundation.text });
    expect(getSkinComponent(manifest, 'taskBubble')).toMatchObject({ material: 'paper' });
    expect(getSkinComponent(parseSkinManifest(bare), 'link')).toMatchObject({ highlight: paper.foundation.accent });
    expect(() => parseSkinManifest({ ...bare, wallpaper: { file: 'personal.png' } })).toThrow();
    expect(() => parseSkinManifest({ ...bare, components: { note: { css: 'border:0' } } })).toThrow();
    expect(() => parseSkinManifest({ ...bare, components: { note: { textureAssetId: 'unknown' } } })).toThrow(/Unknown texture/);
    expect(() => parseSkinManifest({ ...bare, components: { note: { fill: '#FFFFFF', text: '#00000011' } } })).toThrow(/contrast/i);
    expect(() => parseSkinManifest({ ...bare, components: { note: { opacity: 0.1 } } })).toThrow(/contrast/i);
    expect(() => parseSkinManifest({ ...bare, foundation: { ...paper.foundation, priority: { attention: '#abcdee', high: '#ABCDEE' } } })).toThrow(/distinct/i);
    await expect(validateSkinPackage({ ...packed, schemaVersion: 2 })).rejects.toThrow();
  });

  it('creates and parses pinned component references', () => {
    const manifest = BUILT_IN_SKINS[0]!.manifest;
    const reference = createSkinReference(manifest, 'taskBubble');
    expect(reference).toBe('archive-paper@1.0.0/taskBubble');
    expect(parseSkinReference(reference)).toEqual({ skinId: 'archive-paper', version: '1.0.0', componentId: 'taskBubble' });
    expect(() => parseSkinReference('archive-paper/taskBubble')).toThrow(/pinned Skin/);
  });

  it('packs and verifies a self-contained PNG asset', async () => {
    const bytes = png1x1();
    const skinPackage = await packSkin(manifestWithAsset(), new Map([['paper', bytes]]), '柔和的纸面纹理。', provenance());
    expect(skinPackage.assets[0]).toMatchObject({ mediaType: 'image/png', bytes: bytes.byteLength, width: 1, height: 1 });
    expect(skinPackage.assets[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const unpacked = await unpackSkinPackage(skinPackage);
    expect(unpacked.assets.get('paper')).toEqual(bytes);

    const tampered = structuredClone(skinPackage);
    tampered.assets[0]!.sha256 = '0'.repeat(64);
    await expect(validateSkinPackage(tampered)).rejects.toThrow(/digest mismatch/);
  });

  it('rejects executable, remote, vector, and traversal-shaped fields', () => {
    const base = manifestWithAsset() as unknown as Record<string, unknown>;
    const withCss = structuredClone(base) as { components: { background: Record<string, unknown> } };
    withCss.components.background.css = 'body { display: none }';
    expect(() => parseSkinManifest(withCss)).toThrow();

    const withUrl = structuredClone(base) as { components: { background: Record<string, unknown> } };
    withUrl.components.background.textureUrl = 'https://example.com/track.png';
    expect(() => parseSkinManifest(withUrl)).toThrow();

    const withSvg = structuredClone(base) as { assets: Array<Record<string, unknown>> };
    withSvg.assets[0]!.file = 'assets/vector.svg';
    withSvg.assets[0]!.mediaType = 'image/svg+xml';
    expect(() => parseSkinManifest(withSvg)).toThrow();

    const withTraversal = structuredClone(base) as { assets: Array<Record<string, unknown>> };
    withTraversal.assets[0]!.file = '../private.png';
    expect(() => parseSkinManifest(withTraversal)).toThrow();
  });

  it('validates V2 chrome, safe shapes and readable contrast without accepting arbitrary styling', () => {
    const v2 = BUILT_IN_SKINS.find((skin) => skin.manifest.displayName === '夜墨 2.0')!;
    expect(v2.manifest).toMatchObject({ schemaVersion: 2, components: { chrome: { mode: 'dark' }, taskBubble: { shape: { kind: 'circle', aspectLockedDefault: true }, material: 'matte' } } });
    const unsafeShape = structuredClone(v2.manifest) as Record<string, unknown> & { components: { taskBubble: Record<string, unknown> } };
    unsafeShape.components.taskBubble.css = 'clip-path:url(https://example.com/x.svg)';
    expect(() => parseSkinManifest(unsafeShape)).toThrow();
    const lowContrast = structuredClone(v2.manifest) as { components: { taskBubble: { text: string } } };
    lowContrast.components.taskBubble.text = '#272521';
    expect(() => parseSkinManifest(lowContrast)).toThrow(/contrast/i);
  });
});

describe('SkinLibrary', () => {
  it('installs immutable custom packages and resolves a missing component through a pinned fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-skins-'));
    temporaryDirectories.push(root);
    const library = new SkinLibrary(root);
    const manifest: SkinManifest = {
      schemaVersion: 1,
      skinId: 'note-only', version: '1.0.0', displayName: '便签专用', description: '只替换便签的局部 Skin。', assets: [],
      components: {
        note: { fill: '#FFF1BBDD', text: '#332C22', border: '#8B785A', accent: '#C66D4B', shadow: '#332C2222', radius: 8, opacity: 0.95 }
      }
    };
    const skinPackage = await packSkin(manifest, new Map(), '只替换便签。', provenance());
    await expect(library.install(skinPackage)).resolves.toMatchObject({ key: 'note-only@1.0.0', builtIn: false });
    await expect(library.install(skinPackage)).rejects.toThrow(/already installed/);
    expect((await library.list()).some((skin) => skin.key === 'note-only@1.0.0')).toBe(true);
    await expect(library.resolveComponent(
      'note-only@1.0.0/taskBubble',
      'archive-paper@1.0.0/taskBubble'
    )).resolves.toMatchObject({ reference: 'archive-paper@1.0.0/taskBubble', fallbackUsed: true });

    const exported = path.join(root, 'exports', 'note-only.zzskin');
    await library.exportPackage('note-only@1.0.0', exported);
    expect(await fs.stat(exported)).toMatchObject({ size: expect.any(Number) });
  });

  it('requires an explicit scoped library root', () => {
    expect(() => new SkinLibrary('relative/skins')).toThrow(/absolute path/);
    expect(() => new SkinLibrary(path.parse(process.cwd()).root)).toThrow(/filesystem root/);
  });

  it('publishes exactly one complete recipe when two installs race for the same version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-skin-race-'));
    temporaryDirectories.push(root);
    const library = new SkinLibrary(root);
    const template = BUILT_IN_SKINS.find((skin) => skin.schemaVersion === 3)!;
    const variants = ['甲', '乙'].map((displayName) => ({
      ...template, manifest: { ...template.manifest, skinId: 'race', displayName }
    }));
    const results = await Promise.allSettled(variants.map((candidate) => library.install(candidate)));
    const winners = results.filter((item) => item.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect((await library.read('race@3.0.0'))!.manifest.displayName).toBe(winners[0]!.value.displayName);
    expect(await fs.readdir(root)).toEqual(['race@3.0.0.zzskin']);
  });

  it.runIf(process.platform === 'win32')('installs on Windows volumes without hard links and still refuses replacement', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-skin-removable-'));
    temporaryDirectories.push(root);
    const library = new SkinLibrary(root);
    const template = BUILT_IN_SKINS.find((skin) => skin.schemaVersion === 3)!;
    const variants = ['甲', '乙'].map((displayName) => ({ ...template, manifest: { ...template.manifest, skinId: 'portable-skin', displayName } }));
    const hardLinks = vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('Not supported'), { code: 'ENOTSUP' }));
    try {
      const completed = (await Promise.allSettled(variants.map((candidate) => library.install(candidate)))).filter(r => r.status === 'fulfilled');
      expect(completed).toHaveLength(1);
      expect((await library.read('portable-skin@3.0.0'))?.manifest.displayName).toBe(completed[0]!.value.displayName);
      expect(await fs.readdir(root)).toEqual(['portable-skin@3.0.0.zzskin']);
    } finally { hardLinks.mockRestore(); }
  });
});

function manifestWithAsset(): SkinManifest {
  return {
    schemaVersion: 1,
    skinId: 'paper-test',
    version: '1.0.0',
    displayName: '纸张测试',
    description: '仅用于合成测试的 Skin。',
    components: {
      background: {
        surface: '#EEEAE2', accent: '#6C786B', pattern: 'fibers', patternOpacity: 0.12,
        textureAssetId: 'paper', textureOpacity: 0.25
      }
    },
    assets: [{ id: 'paper', file: 'assets/paper.png', mediaType: 'image/png' }]
  };
}

function provenance() {
  return {
    schemaVersion: 1 as const,
    createdAt: '2026-09-04T00:00:00.000Z',
    source: 'generated' as const,
    referenceUsed: false,
    referencePolicy: 'original-reference-not-included' as const,
    generatedWith: ['synthetic test'],
    notes: ''
  };
}

function png1x1(): Uint8Array {
  return Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  ));
}
