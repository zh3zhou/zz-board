import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import postgres from 'postgres';
import { z } from 'zod';
import { feedbackReceiptSchema } from '../../src/shared/feedback.js';

export const feedbackRpcResultSchema = z.object({
  status: z.enum(['accepted', 'duplicate', 'deleted', 'conflict', 'expired', 'forbidden', 'rate_limited', 'invalid']),
  receipt: feedbackReceiptSchema.optional()
}).strict();
export type FeedbackRpcResult = z.infer<typeof feedbackRpcResultSchema>;
export type FeedbackRpc = (name: 'zzb_feedback_submit' | 'zzb_feedback_delete' | 'zzb_feedback_cleanup', args: Record<string, unknown>) => Promise<unknown>;
type Scope = 'intake' | 'retention';

const privateNetwork = new BlockList();
privateNetwork.addSubnet('10.0.0.0', 8);
privateNetwork.addSubnet('172.16.0.0', 12);
privateNetwork.addSubnet('192.168.0.0', 16);
privateNetwork.addSubnet('127.0.0.0', 8);
privateNetwork.addSubnet('fc00::', 7, 'ipv6');
privateNetwork.addAddress('::1', 'ipv6');

async function openPrivatePool(env: NodeJS.ProcessEnv) {
  const host = env.ZZB_FEEDBACK_PG_HOST ?? '';
  const port = Number(env.ZZB_FEEDBACK_PG_PORT);
  const database = env.ZZB_FEEDBACK_PG_DATABASE;
  const user = env.ZZB_FEEDBACK_PG_USER;
  const password = env.ZZB_FEEDBACK_PG_PASSWORD;
  if ((!isIP(host) && !/^(?=.{1,253}$)[a-z0-9.-]+$/i.test(host)) ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !database || !user || !password) {
    throw new Error('Private feedback database settings are incomplete.');
  }
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => !privateNetwork.check(address, family === 6 ? 'ipv6' : 'ipv4'))) {
    throw new Error('The feedback database requires a private destination.');
  }
  // Connect to the already validated IP. Verify the certificate against the original
  // endpoint so DNS changes cannot redirect a pooled connection to the public internet.
  return postgres({ host: addresses[0].address, port, database, user, password,
    ssl: { rejectUnauthorized: true, servername: isIP(host) ? undefined : host,
      checkServerIdentity: (_hostname: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert),
      ...(env.ZZB_FEEDBACK_PG_CA ? { ca: env.ZZB_FEEDBACK_PG_CA } : {}) },
    max: 2, prepare: false, fetch_types: false, connect_timeout: 5, idle_timeout: 10,
    connection: { application_name: 'zzb-feedback', statement_timeout: 8500 },
    onnotice: () => {}
  });
}

export function createFeedbackRpc(scope: Scope, env: NodeJS.ProcessEnv = process.env): FeedbackRpc {
  let pool: ReturnType<typeof openPrivatePool> | undefined;
  return async (name, args) => {
    if ((scope === 'intake' && name !== 'zzb_feedback_submit' && name !== 'zzb_feedback_delete') ||
        (scope === 'retention' && name !== 'zzb_feedback_cleanup')) throw new Error('Operation outside feedback credential scope.');
    try {
      pool ??= openPrivatePool(env).catch(error => { pool = undefined; throw error; });
      const sql = await pool;
      let rows;
      if (name === 'zzb_feedback_submit') {
        rows = await sql`SELECT zzb_feedback_private.zzb_feedback_submit(${String(args.p_report_id)}::uuid,
          ${JSON.stringify(args.p_payload)}::text::jsonb, ${String(args.p_payload_hash)}, ${String(args.p_delete_token_hash)}) AS result`;
      } else if (name === 'zzb_feedback_delete') {
        rows = await sql`SELECT zzb_feedback_private.zzb_feedback_delete(${String(args.p_report_id)}::uuid,
          ${String(args.p_delete_token_hash)}) AS result`;
      } else {
        rows = await sql`SELECT zzb_feedback_private.zzb_feedback_cleanup() AS result`;
      }
      if (rows.length !== 1 || !rows[0]?.result || typeof rows[0].result !== 'object') throw new Error('Invalid feedback response.');
      return rows[0].result;
    } catch { throw new Error('Feedback database request failed.'); }
  };
}
