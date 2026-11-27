import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// This helper uses an already installed official MCP process. It never installs
// a package, changes Codex configuration, or initiates account authorization.
const READ_TOOLS = new Set(['queryEnv', 'queryPgDatabase', 'queryFunctions', 'queryPermissions', 'queryLogs', 'queryAppAuth', 'queryGateway']);
const READ_ACTIONS = new Set(['list', 'info', 'usage', 'context', 'objects', 'metadata', 'schema', 'sql', 'detail', 'get', 'getUserRego', 'getLoginConfig', 'getPublishableKey', 'listApiKeys', 'listRoutes', 'listCustomDomains', 'getPrivilege']);
const METADATA_ACTIONS = {
  queryFunctions: new Set(['listFunctions', 'getFunctionDetail', 'listFunctionTriggers']),
  queryPermissions: new Set(['getPolicy', 'listPolicy', 'getResourcePermission']),
  queryLogs: new Set(['checkLogService'])
};
// Action names and parameters are checked against the official API index/docs.
// No generic cloud API passthrough, writes, policy migrations, or CLS activation.
const CLOUD_READ_ACTIONS = { tcb: new Set(['DescribeBillingInfo', 'DescribeEnvPlans', 'DescribeBaasPackageList', 'DescribeQuotaData', 'DescribeResourcePermission']), cls: new Set(['DescribeTopics']) };

export class CloudBaseReadClient {
  constructor(entry, options = {}) {
    if (!path.isAbsolute(entry)) throw new Error('Pass the absolute path of the existing official cloudbase-mcp entry.');
    this.child = spawn(process.execPath, [entry], { cwd: options.cwd ?? process.cwd(), windowsHide: true, stdio: 'pipe', env: { ...process.env, TCB_SITE: 'domestic', INTEGRATION_IDE: 'CodeX' } });
    this.pending = new Map();
    this.sequence = 0;
    this.child.stdin.on('error', () => {});
    // Vendor stderr may contain account context. Do not echo it to the terminal.
    this.child.stderr.on('data', () => {});
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error('Official MCP request failed. Inspect the provider console without exposing credentials.'));
      else waiting.resolve(message.result);
    });
    this.child.once('exit', () => {
      for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Official MCP process exited.')); }
      this.pending.clear();
    });
  }
  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Official MCP request timed out.')); }, 45_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async connect() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'zzb-feedback-readonly-preflight', version: '1' } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const inventory = await this.request('tools/list', {});
    this.tools = inventory.tools ?? [];
    return this.tools;
  }
  async call(name, args) {
    const authStatus = name === 'auth' && args.action === 'status';
    const cloudRead = name === 'callCloudApi' && CLOUD_READ_ACTIONS[args.service]?.has(args.action);
    if (!authStatus && !cloudRead && (!READ_TOOLS.has(name) || !(METADATA_ACTIONS[name] ?? READ_ACTIONS).has(args.action))) throw new Error('This helper only permits selected read-only metadata tools.');
    if (args.revealEnvValues || args.reveal) throw new Error('Credential disclosure is disabled.');
    if (name === 'queryPgDatabase' && args.action === 'sql') {
      const sql = args.sql ?? '';
      // Deliberately narrow to catalog reads; not arbitrary SELECT on business data.
      if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S|\b(insert|update|delete|create|alter|drop|truncate|copy|execute|set|do)\b/i.test(sql) || !/\b(information_schema|pg_catalog|pg_class|pg_proc|pg_namespace|pg_policies|pg_roles|pg_settings)\b/i.test(sql)) throw new Error('Only a single catalog SELECT is permitted.');
    }
    const result = await this.request('tools/call', { name, arguments: args });
    if (result.isError) throw new Error(`Read-only ${name} failed; no raw provider payload was printed.`);
    const checked = value => {
      if (value?.success === false || value?.Error || value?.Response?.Error) throw new Error(`Read-only ${name} reported failure; no raw provider payload was printed.`);
      return value;
    };
    if (result.structuredContent) return checked(result.structuredContent);
    const blocks = result.content?.filter(item => item.type === 'text').map(item => item.text) ?? [];
    for (const block of blocks) {
      let value;
      try { value = JSON.parse(block); } catch { continue; }
      return checked(value);
    }
    throw new Error(`Read-only ${name} returned an unrecognized response; refusing to print raw content.`);
  }
  async close() {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 3000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const index = process.argv.indexOf('--entry');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: node scripts/cloudbase-feedback-mcp.mjs --entry <existing-official-entry> --inventory');
  const client = new CloudBaseReadClient(process.argv[index + 1]);
  try {
    const inventory = await client.connect();
    if (process.argv.includes('--tools')) console.log(JSON.stringify(inventory.map(tool => tool.name)));
    else if (process.argv.includes('--status')) {
      const status = await client.call('auth', { action: 'status' });
      const shape = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(shape) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shape(item)])) : typeof value;
      console.log(JSON.stringify(shape(status), null, 2));
    } else console.log(JSON.stringify(inventory.filter(tool => process.argv.includes('--additional') ? ['queryFunctions', 'queryPermissions', 'queryLogs'].includes(tool.name) : READ_TOOLS.has(tool.name) || tool.name === 'auth').map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })), null, 2));
  } finally { await client.close(); }
}
