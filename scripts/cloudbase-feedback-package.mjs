import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';

const outAt = process.argv.indexOf('--out');
const output = path.resolve(outAt < 0 ? '.tmp/cloudbase-feedback-package' : process.argv[outAt + 1]);
if (!output.startsWith(path.resolve('.tmp') + path.sep)) throw new Error('Keep function build artifacts inside this workspace .tmp directory.');
await mkdir(output, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, value) => { let crc = value; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1; return crc >>> 0; });
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const bodies = []; const records = []; let offset = 0;
  for (const { name, contents, mode } of entries) {
    const filename = Buffer.from(name); const packed = deflateRawSync(contents, { level: 9 }); const checksum = crc32(contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(0x21, 12);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(contents.length, 22); header.writeUInt16LE(filename.length, 26);
    bodies.push(header, filename, packed);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); record.writeUInt16LE((3 << 8) | 20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10); record.writeUInt16LE(0x21, 14);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(packed.length, 20); record.writeUInt32LE(contents.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE((mode << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
    records.push(record, filename); offset += header.length + filename.length + packed.length;
  }
  const central = Buffer.concat(records); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, central, end]);
}
const manifest = { schemaVersion: 1, runtime: 'Nodejs24.11', cloudInstallDependency: false, packages: {}, sourceSha256: {} };
const notices = new Map([
  ['licenses/postgres-UNLICENSE.txt', 'cloudbase/feedback/licenses/postgres-unlicense.txt'],
  ['licenses/zod-LICENSE.txt', 'node_modules/zod/LICENSE']
]);
for (const [kind, source, entryName] of [['http', 'cloudbase/feedback/http.ts', 'index.cjs'], ['cleanup', 'cloudbase/feedback/cleanup.ts', 'index.js']]) {
  const result = await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, minify: false, metafile: true, legalComments: 'none' });
  const code = result.outputFiles[0].contents;
  const entries = [{ name: entryName, contents: code, mode: 0o100644 }];
  for (const [name, source] of notices) entries.push({ name, contents: await readFile(source), mode: 0o100644 });
  if (kind === 'http') {
    const bootstrap = (await readFile('cloudbase/feedback/scf_bootstrap', 'utf8')).replace(/\r\n/g, '\n');
    if (!bootstrap.startsWith('#!/bin/bash\n') || bootstrap.includes('\r') || bootstrap !== '#!/bin/bash\nexec /var/lang/node24/bin/node index.cjs\n') throw new Error('Invalid CloudBase bootstrap.');
    entries.push({ name: 'scf_bootstrap', contents: Buffer.from(bootstrap), mode: 0o100755 });
  }
  const filename = kind === 'http' ? 'zzb-feedback.zip' : 'zzb-feedback-cleanup.zip';
  const bytes = zip(entries); await writeFile(path.join(output, filename), bytes);
  manifest.packages[kind] = { filename, sha256: sha(bytes), bytes: bytes.length, files: entries.map(entry => ({ name: entry.name, sha256: sha(entry.contents), unixMode: entry.mode.toString(8) })) };
  for (const filename of Object.keys(result.metafile.inputs).filter(filename => !filename.startsWith('node_modules/'))) manifest.sourceSha256[filename] = sha(await readFile(filename));
}
const templatePath = 'cloudbase/feedback/deployment.template.json';
const template = JSON.parse(await readFile(templatePath, 'utf8'));
const migrations = [template.migration, ...template.followUpMigrations];
for (const filename of ['pnpm-lock.yaml', ...notices.values(), 'cloudbase/feedback/scf_bootstrap', templatePath, ...migrations.map(item => item.file), 'cloudbase/feedback/rollback.sql']) {
  manifest.sourceSha256[filename] = sha(await readFile(filename));
}
await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ result: 'PACKAGED', runtime: manifest.runtime, packages: manifest.packages, manifest: path.relative(process.cwd(), path.join(output, 'manifest.json')), deployment: 'not-performed' }));
