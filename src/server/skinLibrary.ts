import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  BUILT_IN_SKINS,
  builtInSkin,
  getSkinComponent,
  MAX_SKIN_PACKAGE_BYTES,
  parseSkinReference,
  serializeSkinPackage,
  skinComponentIds,
  skinVersionKey,
  validateSkinPackage,
  type SkinComponent,
  type SkinComponentId,
  type SkinPackage
} from '../shared/skin.js';

export interface SkinLibraryEntry {
  key: string;
  skinId: string;
  version: string;
  displayName: string;
  description: string;
  builtIn: boolean;
  schemaVersion: SkinPackage['schemaVersion'];
  components: SkinComponentId[];
}

export interface ResolvedSkinComponent {
  reference: string;
  component: SkinComponent;
  fallbackUsed: boolean;
}

export class SkinLibrary {
  readonly root: string;

  constructor(explicitRoot: string) {
    if (!explicitRoot || !path.isAbsolute(explicitRoot)) throw new Error('Skin library root must be an explicit absolute path.');
    this.root = path.resolve(explicitRoot);
    if (this.root === path.parse(this.root).root) throw new Error('Skin library root must not be a filesystem root.');
  }

  async list(): Promise<SkinLibraryEntry[]> {
    await this.ensureRoot();
    const custom: SkinLibraryEntry[] = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.zzskin')) continue;
      const absolute = this.pathWithinRoot(entry.name);
      const skinPackage = await this.readAndValidateFile(absolute);
      custom.push(toEntry(skinPackage, false));
    }
    custom.sort((left, right) => left.displayName.localeCompare(right.displayName, 'zh-CN') || left.key.localeCompare(right.key));
    return [...BUILT_IN_SKINS.map((skin) => toEntry(skin, true)), ...custom];
  }

  async install(input: unknown): Promise<SkinLibraryEntry> {
    const skinPackage = await validateSkinPackage(input);
    const key = skinVersionKey(skinPackage.manifest);
    if (builtInSkin(key)) throw new Error(`Built-in Skin cannot be replaced: ${key}`);
    await this.ensureRoot();
    const destination = this.packagePath(key);
    if (await exists(destination)) throw new Error(`Skin is already installed: ${key}`);
    await atomicWrite(destination, serializeSkinPackage(skinPackage));
    return toEntry(skinPackage, false);
  }

  async read(key: string): Promise<SkinPackage | undefined> {
    assertVersionKey(key);
    const builtin = builtInSkin(key);
    if (builtin) return builtin;
    await this.ensureRoot();
    const file = this.packagePath(key);
    if (!(await exists(file))) return undefined;
    return this.readAndValidateFile(file);
  }

  async exportPackage(key: string, explicitDestination: string): Promise<void> {
    const skinPackage = await this.read(key);
    if (!skinPackage) throw new Error(`Skin is not installed: ${key}`);
    if (!path.isAbsolute(explicitDestination) || path.extname(explicitDestination).toLowerCase() !== '.zzskin') {
      throw new Error('Skin export destination must be an explicit absolute .zzskin path.');
    }
    const destination = path.resolve(explicitDestination);
    if (destination === path.parse(destination).root) throw new Error('Invalid Skin export destination.');
    if (await exists(destination)) throw new Error(`Refusing to overwrite an existing export: ${destination}`);
    const parent = path.dirname(destination);
    await assertSafePathChain(parent);
    await fs.mkdir(parent, { recursive: true });
    await atomicWrite(destination, serializeSkinPackage(skinPackage));
  }

  async resolveComponent(reference: string, fallbackReference: string): Promise<ResolvedSkinComponent> {
    const requested = parseSkinReference(reference);
    const fallback = parseSkinReference(fallbackReference);
    if (requested.componentId !== fallback.componentId) throw new Error('Skin fallback must name the same component type.');
    const requestedPackage = await this.read(`${requested.skinId}@${requested.version}`);
    const requestedComponent = requestedPackage ? getSkinComponent(requestedPackage.manifest, requested.componentId) : undefined;
    if (requestedComponent) return { reference, component: requestedComponent, fallbackUsed: false };
    const fallbackPackage = await this.read(`${fallback.skinId}@${fallback.version}`);
    const fallbackComponent = fallbackPackage ? getSkinComponent(fallbackPackage.manifest, fallback.componentId) : undefined;
    if (!fallbackComponent) throw new Error(`Skin component and fallback are unavailable: ${reference}`);
    return { reference: fallbackReference, component: fallbackComponent, fallbackUsed: true };
  }

  private async ensureRoot(): Promise<void> {
    await assertSafePathChain(this.root);
    if (await exists(this.root)) {
      const stat = await fs.lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Skin library root must be a regular directory: ${this.root}`);
    } else await fs.mkdir(this.root, { recursive: true });
  }

  private packagePath(key: string): string {
    assertVersionKey(key);
    return this.pathWithinRoot(`${key}.zzskin`);
  }

  private pathWithinRoot(filename: string): string {
    const resolved = path.resolve(this.root, filename);
    if (path.dirname(resolved) !== this.root) throw new Error(`Refusing Skin library path traversal: ${filename}`);
    return resolved;
  }

  private async readAndValidateFile(file: string): Promise<SkinPackage> {
    await assertNotSymlink(file, false);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error(`Skin package is not a regular file: ${file}`);
    if (stat.size > MAX_SKIN_PACKAGE_BYTES) throw new Error(`Skin package exceeds ${MAX_SKIN_PACKAGE_BYTES} bytes.`);
    const text = await fs.readFile(file, 'utf8');
    return validateSkinPackage(JSON.parse(text) as unknown);
  }
}

function toEntry(skinPackage: SkinPackage, builtIn: boolean): SkinLibraryEntry {
  const { manifest } = skinPackage;
  return {
    key: skinVersionKey(manifest),
    skinId: manifest.skinId,
    version: manifest.version,
    displayName: manifest.displayName,
    description: manifest.description,
    builtIn,
    schemaVersion: manifest.schemaVersion,
    components: skinComponentIds(manifest)
  };
}

function assertVersionKey(key: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,63}@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(key)) {
    throw new Error(`Invalid pinned Skin version key: ${key}`);
  }
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    // Publish a complete file only if this exact version is still available.
    // rename() can replace a version installed by a second concurrent caller.
    try {
      await fs.link(temporary, destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EINVAL', 'ENOSYS'].includes(code || '')) throw error;
      // FAT/exFAT cannot create hard links. File.Move's two-argument overload
      // also publishes atomically without replacing an existing file.
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ErrorActionPreference='Stop'; [System.IO.File]::Move($env:ZZ_SKIN_STAGED_FILE, $env:ZZ_SKIN_NEW_FILE)"], {
        windowsHide: true, env: { ...process.env, ZZ_SKIN_STAGED_FILE: temporary, ZZ_SKIN_NEW_FILE: destination }
      });
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
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

async function assertNotSymlink(target: string, allowMissing: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Refusing a symlinked Skin path: ${target}`);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function assertSafePathChain(target: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`Refusing a symlinked Skin path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
