const http = require('node:http');

const response = JSON.stringify({ ok: true, canary: 'zzb-deploy-smoke-v1' });

http.createServer((_request, reply) => {
  reply.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(response),
    'cache-control': 'no-store'
  });
  reply.end(response);
}).listen(9000, '0.0.0.0');
