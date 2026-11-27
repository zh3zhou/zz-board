import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const at = process.argv.indexOf('--pglite-entry');
if (at < 0 || !process.argv[at + 1]) throw new Error('Pass --pglite-entry <isolated-tools/node_modules/@electric-sql/pglite/dist/index.js>. No cloud credentials are used.');
const { PGlite } = await import(pathToFileURL(path.resolve(process.argv[at + 1])).href);
// Deliberately in-memory: no local board or external database can be selected.
const db = new PGlite();
const hash = value => createHash('sha256').update(value).digest('hex');
const migration = await readFile('cloudbase/migrations/20261011050000_zzb_feedback.sql', 'utf8');
const rollback = await readFile('cloudbase/feedback/rollback.sql', 'utf8');
let checks = 0;
const passed = () => { checks++; };
async function admin() { await db.exec('RESET ROLE;'); }
async function role(value) {
  await admin();
  await db.query("SELECT set_config('request.jwt.claims', $1, false)", [value === null ? '' : JSON.stringify({ role: value })]);
  if (value) await db.exec(`SET ROLE ${value};`);
}
const makeReport = (id = randomUUID(), created = Date.now()) => ({ schemaVersion: 1, reportId: id, createdAt: new Date(created).toISOString(), retryUntil: new Date(created + 86400000).toISOString(), kind: 'problem', goal: 'Synthetic PG smoke', actual: 'Synthetic only', expected: '', dataImpact: 'none', deleteTokenHash: hash('synthetic-proof') });
async function submit(payload) { const result = await db.query('SELECT public.zzb_feedback_submit($1::uuid,$2::jsonb,$3,$4) AS result', [payload.reportId, JSON.stringify(payload), hash(JSON.stringify(payload)), payload.deleteTokenHash]); return result.rows[0].result; }
async function withdraw(id, proof = hash('synthetic-proof')) { const result = await db.query('SELECT public.zzb_feedback_delete($1::uuid,$2) AS result', [id, proof]); return result.rows[0].result; }
async function resetQuota() { await admin(); await db.exec('TRUNCATE public.zzb_feedback_counters;'); await role('service_role'); }
try {
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$; GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;");
  await db.exec(migration); passed();
  await role('anon');
  await assert.rejects(db.query('SELECT payload FROM public.zzb_feedback_reports'), /permission denied/); passed();
  await admin();
  // Simulate the documented gateway limitation by permitting SQL invocation,
  // then prove the inside-function JWT guard still rejects each caller.
  await db.exec('GRANT EXECUTE ON FUNCTION public.zzb_feedback_take_quota(text), public.zzb_feedback_submit(uuid,jsonb,text,text), public.zzb_feedback_delete(uuid,text), public.zzb_feedback_cleanup() TO anon, authenticated;');
  for (const actor of ['anon', 'authenticated', null]) {
    await role(actor);
    for (const operation of [() => submit(makeReport()), () => withdraw(randomUUID()), () => db.query("SELECT public.zzb_feedback_take_quota('submit')"), () => db.query('SELECT public.zzb_feedback_cleanup()')]) await assert.rejects(operation(), /forbidden/);
    passed();
  }
  await role('service_role');
  const payload = makeReport();
  const first = await submit(payload); assert.equal(first.status, 'accepted');
  assert.equal(Date.parse(first.receipt.retainedUntil) - Date.parse(first.receipt.acceptedAt), 90 * 86400000); passed();
  const repeated = await submit(payload); assert.equal(repeated.status, 'duplicate'); assert.deepEqual(repeated.receipt, first.receipt);
  const repeatedCounters = (await db.query("SELECT bucket, used FROM public.zzb_feedback_counters WHERE bucket LIKE 'submit:%'")).rows;
  assert.equal(repeatedCounters.filter(item => item.bucket.startsWith('submit:day:')).reduce((sum, item) => sum + item.used, 0), 1);
  assert.equal(repeatedCounters.filter(item => item.bucket.startsWith('submit:minute:')).reduce((sum, item) => sum + item.used, 0), 2); passed();
  assert.equal((await submit({ ...payload, actual: 'Changed synthetic content' })).status, 'conflict'); passed();
  assert.equal((await withdraw(payload.reportId, hash('wrong-proof'))).status, 'forbidden'); passed();
  assert.equal((await withdraw(payload.reportId)).status, 'deleted'); assert.equal((await withdraw(payload.reportId)).status, 'deleted');
  assert.equal((await submit(payload)).status, 'expired'); passed();
  const pending = makeReport(); await withdraw(pending.reportId); assert.equal((await submit(pending)).status, 'expired'); passed();
  assert.equal((await submit(makeReport(randomUUID(), Date.now() - 86400000 - 1000))).status, 'expired');
  assert.equal((await submit(makeReport(randomUUID(), Date.now() + 600000))).status, 'invalid'); passed();
  await resetQuota();
  const duplicateOnly = makeReport(); assert.equal((await submit(duplicateOnly)).status, 'accepted');
  await resetQuota();
  for (let count = 0; count < 30; count++) assert.equal((await submit(duplicateOnly)).status, 'duplicate');
  assert.equal((await submit(duplicateOnly)).status, 'rate_limited');
  assert.equal((await db.query("SELECT coalesce(sum(used), 0)::integer AS used FROM public.zzb_feedback_counters WHERE bucket LIKE 'submit:day:%'")).rows[0].used, 0); passed();
  await resetQuota();
  for (let count = 0; count < 30; count++) assert.equal((await submit(makeReport())).status, 'accepted');
  assert.equal((await submit(makeReport())).status, 'rate_limited');
  // Submit saturation does not consume the separate withdrawal quota.
  assert.equal((await withdraw(randomUUID())).status, 'deleted'); passed();
  await admin();
  await db.exec("UPDATE public.zzb_feedback_counters SET used = CASE WHEN bucket LIKE 'submit:day:%' THEN 499 ELSE 0 END WHERE bucket LIKE 'submit:%';");
  await role('service_role');
  // A duplicate is acknowledged even after the new-report day budget is full.
  assert.equal((await submit(duplicateOnly)).status, 'duplicate');
  assert.equal((await db.query("SELECT used FROM public.zzb_feedback_counters WHERE bucket LIKE 'submit:day:%'")).rows[0].used, 499);
  assert.equal((await submit(makeReport())).status, 'accepted');
  assert.equal((await submit(duplicateOnly)).status, 'duplicate');
  assert.equal((await submit(makeReport())).status, 'rate_limited');
  assert.equal((await db.query("SELECT used FROM public.zzb_feedback_counters WHERE bucket LIKE 'submit:day:%'")).rows[0].used, 500); passed();
  await admin();
  await db.exec("WITH instant AS (SELECT clock_timestamp()-interval '2200 hours' AS value) UPDATE public.zzb_feedback_reports SET accepted_at=instant.value, retained_until=instant.value+interval '2160 hours' FROM instant;");
  await db.exec("UPDATE public.zzb_feedback_tombstones SET expires_at=clock_timestamp()-interval '1 hour'; UPDATE public.zzb_feedback_counters SET started_at=clock_timestamp()-interval '49 hours';");
  await role('service_role');
  const cleaned = (await db.query('SELECT public.zzb_feedback_cleanup() AS result')).rows[0].result;
  assert.ok(cleaned.reportsDeleted > 0); assert.ok(cleaned.tombstonesDeleted > 0); assert.ok(cleaned.countersDeleted > 0); passed();
  await admin();
  await db.exec(await readFile('cloudbase/migrations/20261127060000_zzb_feedback_processing.sql', 'utf8'));
  await db.exec(await readFile('cloudbase/migrations/20261127070000_zzb_feedback_scoped.sql', 'utf8'));
  await db.exec(`CREATE ROLE synthetic_intake LOGIN; CREATE ROLE synthetic_retention LOGIN;
    GRANT zzb_feedback_intake TO synthetic_intake WITH INHERIT TRUE, SET FALSE;
    GRANT zzb_feedback_retention TO synthetic_retention WITH INHERIT TRUE, SET FALSE`);
  await db.exec('SET SESSION AUTHORIZATION synthetic_intake');
  await assert.rejects(db.query('SELECT report_id FROM public.zzb_feedback_reports LIMIT 0'), { code:'42501' });
  await assert.rejects(db.query('SELECT zzb_feedback_private.zzb_feedback_cleanup()'), { code:'42501' });
  const sample = makeReport();
  const privateSubmit = () => db.query('SELECT zzb_feedback_private.zzb_feedback_submit($1::uuid,$2::jsonb,$3,$4) AS result',
    [sample.reportId, JSON.stringify(sample), hash(JSON.stringify(sample)), sample.deleteTokenHash]);
  assert.equal((await privateSubmit()).rows[0].result.status, 'accepted');
  assert.equal((await privateSubmit()).rows[0].result.status, 'duplicate');
  assert.equal((await db.query('SELECT zzb_feedback_private.zzb_feedback_delete($1::uuid,$2) AS result',
    [sample.reportId, sample.deleteTokenHash])).rows[0].result.status, 'deleted');
  assert.equal((await privateSubmit()).rows[0].result.status, 'expired'); passed();
  await db.exec('SET SESSION AUTHORIZATION postgres; SET SESSION AUTHORIZATION synthetic_retention');
  await assert.rejects(db.query('SELECT zzb_feedback_private.zzb_feedback_delete(NULL,NULL)'), {code:'42501'});
  await assert.rejects(db.query('SELECT report_id FROM public.zzb_feedback_reports LIMIT 0'), {code:'42501'});
  const counts = (await db.query('SELECT zzb_feedback_private.zzb_feedback_cleanup() AS result')).rows[0].result;
  assert.deepEqual(Object.keys(counts).sort(), ['countersDeleted','reportsDeleted','tombstonesDeleted']); passed();
  await db.exec('SET SESSION AUTHORIZATION postgres');
  await assert.rejects(db.exec(rollback), /Unbind/);
  await db.exec('ROLLBACK; REVOKE zzb_feedback_intake FROM synthetic_intake; REVOKE zzb_feedback_retention FROM synthetic_retention');
  await db.exec(rollback);
  assert.equal((await db.query("SELECT count(*) AS count FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'zzb_feedback_%'")).rows[0].count, 0); passed();
  console.log(JSON.stringify({ result: 'PASS', checks, engine: 'PGlite in-memory PostgreSQL', limits: 'Single connection; does not prove CloudBase RPC enforcement, deployed HTTP transport, or multi-instance races.' }));
} finally { await db.close(); }
