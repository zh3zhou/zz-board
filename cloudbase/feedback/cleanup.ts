import { z } from 'zod';
import { createFeedbackRpc, type FeedbackRpc } from './rpc.js';

const cleanupReceipt = z.object({ reportsDeleted: z.number().int().nonnegative(), tombstonesDeleted: z.number().int().nonnegative(), countersDeleted: z.number().int().nonnegative() }).strict();
export async function cleanupFeedback(rpc: FeedbackRpc) { return cleanupReceipt.parse(await rpc('zzb_feedback_cleanup', {})); }
const retentionRpc = createFeedbackRpc('retention');
export async function main() {
  try {
    const counts = await cleanupFeedback(retentionRpc);
    console.log(JSON.stringify(counts));
    return counts;
  } catch { throw new Error('Feedback cleanup failed.'); }
}
