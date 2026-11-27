import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { CloudBaseReadClient } from './cloudbase-feedback-mcp.mjs';

const entryAt = process.argv.indexOf('--entry');
const outputAt = process.argv.indexOf('--out');
if (entryAt < 0 || !process.argv[entryAt + 1]) throw new Error('Pass --entry <already-installed-official-dist/cli.cjs>.');
const output = path.resolve(outputAt < 0 ? '.tmp/cloudbase-feedback-preflight' : process.argv[outputAt + 1]);
const privateRoot = path.resolve('.tmp');
if (!output.startsWith(privateRoot + path.sep)) throw new Error('Preflight evidence must remain in this workspace .tmp directory.');
const entry = path.resolve(process.argv[entryAt + 1]);
const pkg = JSON.parse(await readFile(path.resolve(entry, '../../package.json'), 'utf8'));
if (pkg.name !== '@cloudbase/cloudbase-mcp' || path.basename(entry) !== 'cli.cjs') throw new Error('Entry must be the existing official CloudBase MCP CLI.');
const sha = value => createHash('sha256').update(value).digest('hex');
const client = new CloudBaseReadClient(entry);
const report = { schemaVersion: 1, checkedAt: new Date().toISOString(), mode: 'read-only', providerVersion: pkg.version, providerEntrySha256: sha(await readFile(entry)), checks: {}, gates: { noNewCharges: 'unverified', existingPolicyPreserved: 'unverified', logRetentionDays: 'unverified', backupRetentionDays: 'unverified', publishableWebfnSyntheticSmoke: 'not-run', trustedSourceIp: 'not-proved' } };
const shape = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(shape) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value;
const allObjects = value => !value || typeof value !== 'object' ? [] : [value, ...Object.values(value).flatMap(allObjects)];
const selected = (value, keys) => allObjects(value).flatMap(item => Object.entries(item).filter(([key]) => keys.includes(key)).map(([key, entry]) => ({ key, value: entry })));
async function check(label, name, args, project = shape) {
  try { const value = await client.call(name, args); report.checks[label] = { status: 'read', metadata: project(value) }; return value; }
  catch { report.checks[label] = { status: 'unavailable', reason: 'Read failed; no raw provider response exposed.' }; return null; }
}
await mkdir(output, { recursive: true });
try {
  const schemas = await client.connect();
  await writeFile(path.join(output, 'mcp-tool-schemas.json'), JSON.stringify(schemas, null, 2) + '\n');
  const auth = await check('authorization', 'auth', { action: 'status' }, value => ({ ready: value.auth_status === 'READY', credentialScope: value.credential_scope, region: value.current_region, envReady: value.env_status === 'READY' }));
  if (!auth || auth.auth_status !== 'READY' || !auth.current_env_id || auth.current_region !== 'ap-shanghai') throw new Error('Existing authorized Shanghai environment was not confirmed; do not change login or binding.');
  const envs = await check('environmentSelection', 'queryEnv', { action: 'list', region: 'ap-shanghai', fields: ['EnvId', 'Status', 'EnvType', 'Region', 'PackageId', 'PackageName'], limit: 20 }, value => ({ responseShape: shape(value) }));
  const candidates = allObjects(envs).filter(value => value.EnvId === auth.current_env_id || value.envId === auth.current_env_id);
  if (!candidates.length) throw new Error('Authorized environment was not found in the same region list.');
  // Environment identity and raw policy are private rollback material, not public docs.
  await writeFile(path.join(output, 'target.private.json'), JSON.stringify({ envId: auth.current_env_id, region: 'ap-shanghai' }, null, 2) + '\n');
  const environment = await check('environmentCapabilities', 'queryEnv', { action: 'info', envId: auth.current_env_id }, value => {
    const keys = new Set(['Status', 'EnvType', 'Region', 'PackageId', 'PackageName', 'PayMode', 'RuntimeMode', 'RuntimeBackends']);
    return allObjects(value).flatMap(item => Object.entries(item).filter(([key]) => keys.has(key)).map(([key, item]) => ({ key, value: item })));
  });
  await check('packageUsage', 'queryEnv', { action: 'usage', envId: auth.current_env_id, type: ['SCF', 'APIInvocation', 'Auth'], needUsageDetails: false }, value => selected(value, ['Module', 'MetricName', 'Unit', 'Value', 'ReportValue', 'OriginCredits', 'PackageDeductValue']));
  await check('pgContext', 'queryPgDatabase', { action: 'context' });
  await check('feedbackNameCollisions', 'queryPgDatabase', { action: 'sql', sql: "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'zzb_feedback_%' ORDER BY table_name, ordinal_position", limit: 200 }, value => value);
  await check('authRoleCapabilities', 'queryPgDatabase', { action: 'sql', sql: "SELECT rolname, rolbypassrls FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role')", limit: 10 }, value => value);
  await check('functionInventory', 'queryFunctions', { action: 'listFunctions', limit: 100 }, value => ({ responseShape: shape(value), existingFeedbackNames: allObjects(value).flatMap(item => Object.values(item)).filter(item => item === 'zzb-feedback' || item === 'zzb-feedback-cleanup') }));
  const policy = await check('existingGatewayPolicy', 'queryPermissions', { action: 'getPolicy' });
  if (policy) { const encoded = JSON.stringify(policy); report.policyPreimageSha256 = sha(encoded); await writeFile(path.join(output, 'policy-preimage.private.json'), encoded + '\n'); }
  await check('functionResourcePermissions', 'queryPermissions', { action: 'getResourcePermission', resourceType: 'function', resourceId: '*' });
  await check('publishableKeyReadiness', 'queryAppAuth', { action: 'getPublishableKey' }, value => ({ ready: typeof value.publishableKey === 'string' && value.publishableKey.length > 0, credentialValuesNotPersisted: true }));
  await check('existingServerKeyMetadata', 'queryAppAuth', { action: 'listApiKeys', keyType: 'api_key', pageSize: 20 }, value => ({ count: Array.isArray(value.apiKeys) ? value.apiKeys.length : null, credentialValuesNotPersisted: true }));
  await check('existingLogService', 'queryLogs', { action: 'checkLogService' }, value => selected(value, ['enabled']));
  const cloud = (action, params) => ({ service: 'tcb', action, version: '2018-06-08', region: 'ap-shanghai', params });
  const billing = await check('billingAndOverrun', 'callCloudApi', cloud('DescribeBillingInfo', { EnvId: auth.current_env_id }), value => selected(value, ['EnableOverrun', 'PackageId', 'PayMode', 'Status', 'EnvActivated', 'EnvCharged', 'FreeQuota', 'IsAlwaysFree', 'IsAutoRenew']));
  const matchingBilling = allObjects(billing).find(item => item.EnvId === auth.current_env_id && typeof item.EnableOverrun === 'boolean');
  if (matchingBilling) report.gates.noNewCharges = matchingBilling.EnableOverrun ? 'overrun-enabled-existing-cost-risk' : 'overrun-disabled; per-resource-package-coverage-still-unverified';
  await check('currentPackageSaleDetails', 'callCloudApi', cloud('DescribeEnvPlans', { PackageId: 'baas_personal' }), value => ({ interpretation: 'Sale plan, not proof of grandfathered environment entitlements.', entries: selected(value, ['PackageId', 'PackageTitle', 'PackageType', 'ResourceLimit']) }));
  await check('environmentPackageDetails', 'callCloudApi', cloud('DescribeBaasPackageList', { EnvId: auth.current_env_id, PackageName: 'baas_personal', Source: 'qcloud' }), value => ({ interpretation: 'Available package metadata; compare with actual environment billing.', entries: selected(value, ['PackageName', 'PackageTitle', 'GroupName', 'ResourceLimit', 'ResourceQuota', 'ResourceList']) }));
  await check('functionCurrentMonthUsage', 'callCloudApi', cloud('DescribeQuotaData', { EnvId: auth.current_env_id, MetricName: 'FunctionInvocationpkg' }), value => selected(value, ['MetricName', 'Value', 'SubValue']));
  const permissions = await check('exactLegacyFunctionPermissions', 'callCloudApi', cloud('DescribeResourcePermission', { EnvId: auth.current_env_id, ResourceType: 'function', Resources: [] }), value => ({ responseShape: shape(value), entries: selected(value, ['Permission', 'ResourceType']), rawSecurityRuleNotPublished: true }));
  if (permissions) { const encoded = JSON.stringify(permissions); report.functionPermissionPreimageSha256 = sha(encoded); await writeFile(path.join(output, 'function-permission-preimage.private.json'), encoded + '\n'); }
  const topic = allObjects(environment).find(item => typeof item.TopicId === 'string' && item.TopicId);
  if (topic) await check('existingClsRetention', 'callCloudApi', { service: 'cls', action: 'DescribeTopics', version: '2020-10-16', region: 'ap-shanghai', params: { Filters: [{ Key: 'topicId', Values: [topic.TopicId] }], Limit: 1 } }, value => selected(value, ['Period', 'Status', 'EnableHotPeriod', 'HotPeriod', 'AssumerName']));
  else report.checks.existingClsRetention = { status: 'unavailable', reason: 'No bound CLS TopicId in environment metadata; no unrelated topics queried and CLS not enabled.' };
  report.checks.actualPgBackupRetention = { status: 'unavailable', reason: 'No documented environment-specific PG backup metadata action confirmed. Generic document-database 7-day documentation is not PG evidence.' };
  report.completed = true;
} catch (error) { report.completed = false; report.failure = error instanceof Error ? error.message : 'Read-only preflight failed.'; }
finally { await client.close(); await writeFile(path.join(output, 'preflight.json'), JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify({ completed: report.completed, mode: report.mode, checks: Object.fromEntries(Object.entries(report.checks).map(([key, value]) => [key, value.status])), gates: report.gates, evidence: path.relative(process.cwd(), path.join(output, 'preflight.json')), failure: report.failure }));
if (!report.completed) process.exitCode = 1;
