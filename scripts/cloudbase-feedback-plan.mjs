import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

if (process.argv.includes('--apply')) throw new Error('This review helper never changes cloud resources. The authorized controller applies individually reviewed steps.');
const packageAt = process.argv.indexOf('--package');
const directory = path.resolve(packageAt < 0 ? '.tmp/cloudbase-feedback-package' : process.argv[packageAt + 1]);
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const template = JSON.parse(await readFile('cloudbase/feedback/deployment.template.json', 'utf8'));
const sha = value => createHash('sha256').update(value).digest('hex');
for (const [filename, expected] of Object.entries(manifest.sourceSha256)) if (sha(await readFile(filename)) !== expected) throw new Error('Source drift detected; repackage before deployment review.');
for (const item of Object.values(manifest.packages)) if (sha(await readFile(path.join(directory, item.filename))) !== item.sha256) throw new Error('ZIP artifact hash mismatch.');
console.log(JSON.stringify({
  mode: 'review-only', deployment: 'blocked-until-gates-proven', gates: template.gates,
  migration: template.migration,
  followUpMigrations: template.followUpMigrations,
  privatePilot: { connection: 'Verified private PostgreSQL endpoint and certificate; two distinct non-administrative database logins.',
    network: 'Use the known database VPC/subnet on both functions. Keep gateways, public invocation, timers and public database access disabled for the pilot.',
    verification: 'Verify scoped SQL grants and per-login denials using the actual private credentials. Test submission, duplicate, withdrawal and separate expiry cleanup with synthetic data.' },
  httpZip: manifest.packages.http,
  httpUploadStep: { tool: 'queryFunctions', arguments: { action: 'getFunctionUploadUrl', functionName: 'zzb-feedback' }, sensitiveResult: 'Keep uploadUrl and uploadHeaders in memory; upload bytes with native HTTPS PUT, then pass returned COS triplet unchanged.' },
  httpCreateStep: { tool: 'manageFunctions', arguments: { action: 'createFunction', force: false, func: template.httpFunction }, code: 'Use exact own-environment cosBucketName/cosObjectName/cosBucketRegion from upload result. Never local folder/zipFile auto-install path.' },
  cleanupZip: manifest.packages.cleanup,
  cleanupCreateStep: { route: 'official CloudBase named-function deployment', function: template.cleanupFunction, constraint: 'Use the deployed runtime version only after confirming support. Prove the Event function is private before creating or invoking it.' },
  postAcceptanceTimer: template.postAcceptanceTimer,
  permissionConstraint: 'No HTTP gateway alias route, OPA migration, global function allow, login-method change, CLS binding, upgrades, or other new paid capabilities.',
  rollback: 'cloudbase/feedback/rollback.sql only removes named feedback objects; disable/delete only named functions/triggers after controller review.'
}, null, 2));
