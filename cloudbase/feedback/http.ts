import { createServer } from 'node:http';
import { createFeedbackRpc } from './rpc.js';
import { createFeedbackHandler } from './service.js';

const enabled = process.env.ZZB_FEEDBACK_ENABLED === 'true';
const rpc = createFeedbackRpc('intake');
createServer(createFeedbackHandler(rpc, enabled)).listen(9000, '0.0.0.0');
