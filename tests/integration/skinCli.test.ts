import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const skinCli = path.join(repoRoot, 'scripts', 'skin-cli.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('Skin CLI', () => {
  it('initializes an editable V3 grid-paper recipe and refuses existing or invalid destinations', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-skin-init-'));
    temporaryDirectories.push(root);
    const source = path.join(root, '我的外观');
    const result = JSON.parse((await run('init', source, '--id', 'my-paper', '--name', '我的纸面')).stdout);
    expect(result).toMatchObject({ status: 'initialized', key: 'my-paper@1.0.0', installed: false, applied: false });
    expect((await fs.readdir(source)).sort()).toEqual(['assets', 'provenance.json', 'skin.json', 'style-brief.md']);
    const manifest = JSON.parse(await fs.readFile(path.join(source, 'skin.json'), 'utf8'));
    expect(manifest).toMatchObject({ schemaVersion: 3, skinId: 'my-paper', displayName: '我的纸面', foundation: { material: 'paper' }, components: { background: { pattern: 'grid' } }, assets: [] });
    expect(JSON.parse((await run('validate', source)).stdout)).toMatchObject({ status: 'valid', assets: 0, components: ['background', 'chrome', 'taskBubble', 'note', 'link', 'inkPalette'] });
    const packed = path.join(root, 'my-paper.zzskin');
    await run('pack', source, packed);
    expect(JSON.parse((await run('validate', packed)).stdout)).toMatchObject({ status: 'valid', key: 'my-paper@1.0.0' });
    const before = await fs.readFile(path.join(source, 'skin.json'));
    await expect(run('init', source, '--id', 'other', '--name', 'other')).rejects.toThrow();
    expect(await fs.readFile(path.join(source, 'skin.json'))).toEqual(before);
    const invalid = path.join(root, 'invalid');
    await expect(run('init', invalid, '--id', '../escape', '--name', 'invalid')).rejects.toThrow();
    await expect(fs.stat(invalid)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('validates, packs, installs, lists, and exports without applying board state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zz-board-skin-cli-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'source');
    const assets = path.join(source, 'assets');
    const packed = path.join(root, 'quiet-test.zzskin');
    const library = path.join(root, 'library');
    const exported = path.join(root, 'exported', 'quiet-test.zzskin');
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(source, 'skin.json'), JSON.stringify({
      schemaVersion: 2,
      skinId: 'quiet-test',
      version: '2.0.0',
      displayName: '安静测试',
      description: '合成测试用的局部 Skin。',
      components: {
        link: { color: '#556677', highlight: '#CC7755', width: 2, style: 'solid', opacity: 0.7 }
      },
      assets: []
    }), 'utf8');
    await fs.writeFile(path.join(source, 'style-brief.md'), '安静的蓝灰连线。', 'utf8');
    await fs.writeFile(path.join(source, 'provenance.json'), JSON.stringify({
      schemaVersion: 1,
      createdAt: '2026-09-04T00:00:00.000Z',
      source: 'original',
      referenceUsed: false,
      referencePolicy: 'original-reference-not-included',
      generatedWith: [],
      notes: ''
    }), 'utf8');

    const validated = await run('validate', source);
    expect(JSON.parse(validated.stdout)).toMatchObject({ status: 'valid', key: 'quiet-test@2.0.0', assets: 0 });
    await run('pack', source, packed);
    const installed = await run('install', packed, '--library', library);
    expect(JSON.parse(installed.stdout)).toMatchObject({ status: 'installed', key: 'quiet-test@2.0.0' });
    const listed = await run('list', '--library', library);
    expect(JSON.parse(listed.stdout).skins).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'quiet-test@2.0.0', builtIn: false, schemaVersion: 2 })
    ]));
    await run('export', 'quiet-test@2.0.0', exported, '--library', library);
    expect((await fs.stat(exported)).size).toBeGreaterThan(0);
  });
});

function run(...command: string[]) {
  return execFileAsync(process.execPath, [tsxCli, skinCli, ...command], { cwd: repoRoot });
}
