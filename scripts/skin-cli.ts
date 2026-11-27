import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_SKIN_ASSET_BYTES,
  MAX_SKIN_PACKAGE_BYTES,
  packSkin,
  parseSkinManifest,
  serializeSkinPackage,
  skinComponentIds,
  validateSkinPackage,
  type SkinPackage
} from '../src/shared/skin.js';
import { SkinLibrary } from '../src/server/skinLibrary.js';

const args = process.argv.slice(2);

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const command = args.shift();
  if (command === 'init') return initCommand(requireArgument('new source directory'), requiredOption('--id'), requiredOption('--name'));
  if (command === 'validate') return validateCommand(requireArgument('source directory or .zzskin file'));
  if (command === 'pack') return packCommand(requireArgument('source directory'), requireArgument('output .zzskin file'));
  if (command === 'install') return installCommand(requireArgument('.zzskin file'), requiredOption('--library'));
  if (command === 'list') return listCommand(requiredOption('--library'));
  if (command === 'export') {
    return exportCommand(requireArgument('skinId@version'), requireArgument('output .zzskin file'), requiredOption('--library'));
  }
  throw new Error('Usage: skin-cli <init|validate|pack|install|list|export> ...');
}

async function initCommand(output: string, id: string, name: string): Promise<void> {
  ensureNoRemainingArguments();
  const manifest = parseSkinManifest({
    schemaVersion: 3, skinId: id, version: '1.0.0', displayName: name,
    description: '暖白方格纸搭配蓝墨水，浅蓝和靛蓝标出两档优先级。',
    foundation: {
      paper: '#F6F1E5', text: '#253C58', accent: '#305B88',
      priority: { attention: '#C4D8EC', high: '#315B87' }, material: 'paper'
    },
    components: { background: { pattern: 'grid', patternOpacity: 0.14 } },
    assets: []
  });
  const destination = path.resolve(output);
  // mkdir without recursive mode is an atomic no-overwrite boundary. The
  // caller chooses an existing parent; we never merge with someone else's kit.
  await fs.mkdir(destination);
  await fs.mkdir(path.join(destination, 'assets'));
  await fs.writeFile(path.join(destination, 'skin.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'style-brief.md'), '# 蓝墨方格\n\n用蓝墨水写在暖白方格纸上。方格留在画布，便签正文保持整洁。浅蓝表示「关注」，靛蓝表示「优先」。\n', { flag: 'wx' });
  await fs.writeFile(path.join(destination, 'provenance.json'), JSON.stringify({ schemaVersion: 1, createdAt: new Date().toISOString(), source: 'adapted', referenceUsed: false, referencePolicy: 'original-reference-not-included', generatedWith: [], notes: 'Adapted from the bundled blue-ink V3 starter.' }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ status: 'initialized', source: destination, key: `${id}@1.0.0`, installed: false, applied: false, next: 'Edit skin.json, then skin validate and skin pack.' }, null, 2));
}

async function validateCommand(source: string): Promise<void> {
  ensureNoRemainingArguments();
  const absolute = path.resolve(source);
  const stat = await fs.lstat(absolute);
  const skinPackage = stat.isDirectory() ? await packageSourceDirectory(absolute) : await readPackageFile(absolute);
  printSummary('valid', skinPackage);
}

async function packCommand(source: string, output: string): Promise<void> {
  ensureNoRemainingArguments();
  const skinPackage = await packageSourceDirectory(path.resolve(source));
  const destination = path.resolve(output);
  if (path.extname(destination).toLowerCase() !== '.zzskin') throw new Error('Packed Skin output must use the .zzskin extension.');
  if (await exists(destination)) throw new Error(`Refusing to overwrite an existing file: ${destination}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, serializeSkinPackage(skinPackage), { encoding: 'utf8', flag: 'wx' });
  printSummary('packed', skinPackage, { output: destination });
}

async function installCommand(source: string, libraryRoot: string): Promise<void> {
  ensureNoRemainingArguments();
  const library = new SkinLibrary(requireAbsolute(libraryRoot, 'Skin library'));
  const installed = await library.install(await readPackageFile(path.resolve(source)));
  console.log(JSON.stringify({ status: 'installed', ...installed }, null, 2));
}

async function listCommand(libraryRoot: string): Promise<void> {
  ensureNoRemainingArguments();
  const library = new SkinLibrary(requireAbsolute(libraryRoot, 'Skin library'));
  console.log(JSON.stringify({ skins: await library.list() }, null, 2));
}

async function exportCommand(key: string, output: string, libraryRoot: string): Promise<void> {
  ensureNoRemainingArguments();
  const library = new SkinLibrary(requireAbsolute(libraryRoot, 'Skin library'));
  const destination = requireAbsolute(output, 'Skin export destination');
  await library.exportPackage(key, destination);
  console.log(JSON.stringify({ status: 'exported', key, output: destination }, null, 2));
}

async function packageSourceDirectory(sourceRoot: string): Promise<SkinPackage> {
  await assertRegularDirectory(sourceRoot);
  const rootEntries = await fs.readdir(sourceRoot, { withFileTypes: true });
  const expectedRootEntries = new Set(['skin.json', 'style-brief.md', 'provenance.json', 'assets']);
  for (const entry of rootEntries) {
    if (!expectedRootEntries.has(entry.name) || entry.isSymbolicLink()) {
      throw new Error(`Unexpected entry in Skin source directory: ${entry.name}`);
    }
  }
  if (rootEntries.length !== expectedRootEntries.size) throw new Error('Skin source inventory is incomplete.');
  const manifestPath = safeSourcePath(sourceRoot, 'skin.json');
  const styleBriefPath = safeSourcePath(sourceRoot, 'style-brief.md');
  const provenancePath = safeSourcePath(sourceRoot, 'provenance.json');
  const assetsRoot = safeSourcePath(sourceRoot, 'assets');
  await Promise.all([
    assertRegularFile(manifestPath),
    assertRegularFile(styleBriefPath),
    assertRegularFile(provenancePath),
    assertRegularDirectory(assetsRoot)
  ]);
  const [manifestText, styleBrief, provenanceText] = await Promise.all([
    fs.readFile(manifestPath, 'utf8'),
    fs.readFile(styleBriefPath, 'utf8'),
    fs.readFile(provenancePath, 'utf8')
  ]);
  const manifest = parseSkinManifest(parseJson(manifestText, 'skin.json'));
  const declaredFiles = new Set(manifest.assets.map((asset) => path.basename(asset.file).toLowerCase()));
  const entries = await fs.readdir(assetsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Skin assets must be regular files: ${entry.name}`);
    if (!declaredFiles.has(entry.name.toLowerCase())) throw new Error(`Undeclared file in Skin assets directory: ${entry.name}`);
  }
  if (entries.length !== manifest.assets.length) throw new Error('Skin asset declarations and source files differ.');
  const sourceAssets = new Map<string, Uint8Array>();
  for (const asset of manifest.assets) {
    const assetPath = safeSourcePath(sourceRoot, asset.file);
    await assertRegularFile(assetPath);
    const stat = await fs.stat(assetPath);
    if (stat.size > MAX_SKIN_ASSET_BYTES) throw new Error(`Skin asset exceeds ${MAX_SKIN_ASSET_BYTES} bytes: ${asset.id}`);
    sourceAssets.set(asset.id, await fs.readFile(assetPath));
  }
  return packSkin(manifest, sourceAssets, styleBrief, parseJson(provenanceText, 'provenance.json'));
}

async function readPackageFile(file: string): Promise<SkinPackage> {
  await assertRegularFile(file);
  if (path.extname(file).toLowerCase() !== '.zzskin') throw new Error('Skin package must use the .zzskin extension.');
  const stat = await fs.stat(file);
  if (stat.size > MAX_SKIN_PACKAGE_BYTES) throw new Error(`Skin package exceeds ${MAX_SKIN_PACKAGE_BYTES} bytes.`);
  return validateSkinPackage(parseJson(await fs.readFile(file, 'utf8'), path.basename(file)));
}

function printSummary(status: string, skinPackage: SkinPackage, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    status,
    key: `${skinPackage.manifest.skinId}@${skinPackage.manifest.version}`,
    components: skinComponentIds(skinPackage.manifest),
    assets: skinPackage.assets.length,
    bytes: new TextEncoder().encode(JSON.stringify(skinPackage)).byteLength,
    ...extra
  }, null, 2));
}

function requireArgument(label: string): string {
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`Missing ${label}.`);
  return value;
}

function requiredOption(name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`Missing required option ${name}.`);
  const [value] = args.splice(index + 1, 1);
  args.splice(index, 1);
  return value!;
}

function ensureNoRemainingArguments(): void {
  if (args.length) throw new Error(`Unknown argument(s): ${args.join(', ')}`);
}

function requireAbsolute(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} path must be absolute.`);
  return path.resolve(value);
}

function safeSourcePath(root: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.includes('\\')) throw new Error(`Unsafe Skin source path: ${relative}`);
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Refusing Skin source path traversal: ${relative}`);
  return resolved;
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`Invalid JSON in ${label}.`);
  }
}

async function assertRegularFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular non-symlink file: ${file}`);
}

async function assertRegularDirectory(directory: string): Promise<void> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a regular non-symlink directory: ${directory}`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export const skinCliPath = fileURLToPath(import.meta.url);
