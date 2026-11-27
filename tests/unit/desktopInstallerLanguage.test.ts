import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const desktop = new URL('../../src-tauri/', import.meta.url);
const config = JSON.parse(await readFile(new URL('tauri.conf.json', desktop), 'utf8')).bundle.windows.nsis;
const selected = config.customLanguageFiles.English;
const english = await readFile(new URL(selected, desktop), 'utf8');
const messagePattern = /LangString (\w+) \$\{LANG_ENGLISH\} (["'])([^\r\n]+?)\2(?=\r?\n|$)/g;
const messages = (text: string) => new Map(Array.from(text.matchAll(messagePattern), match => [match[1], match[3]]));
const catalog = messages(english);
const upgrade = 'olderOrUnknownVersionInstalled';

it('tells Windows users which selected option keeps their pinned shortcuts and keeps explicit uninstall available', async () => {
  expect(config.languages).toContain('English');
  const policy = JSON.parse(await readFile(new URL('../../docs/public-launch/export-policy.json', import.meta.url), 'utf8'));
  expect(policy.requiredDesktopFiles).toContain('src-tauri/' + selected);
  expect(catalog.get(upgrade)).toContain('leave "' + catalog.get('dontUninstall') + '" selected');
  expect(catalog.get(upgrade)).toMatch(/keep your taskbar and Start menu shortcuts/i);
  expect(catalog.get('uninstallBeforeInstalling')).toBe('Uninstall before installing');
});

it.skipIf(process.platform !== 'win32' || process.arch !== 'x64')('keeps the rest of the pinned Tauri CLI English catalog intact', async () => {
  // The bundler ships its upstream .nsh texts inside the platform binary.
  // customLanguageFiles replaces the whole catalog, including uninstall text.
  const cliRequire = createRequire(createRequire(import.meta.url).resolve('@tauri-apps/cli/package.json'));
  const binary = await readFile(cliRequire.resolve('@tauri-apps/cli-win32-x64-msvc'));
  const upstream = messages(binary.toString('latin1'));
  expect(upstream.has(upgrade)).toBe(true);
  expect([...catalog.keys()].sort()).toEqual([...upstream.keys()].sort());
  for (const [key, value] of upstream) if (key !== upgrade) expect(catalog.get(key)).toBe(value);
});
