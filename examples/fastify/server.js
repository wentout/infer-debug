/**
 * Fastify usage of infer-debug — one plugin registration does everything.
 *
 *   INFER_DEBUG=true node examples/fastify/server.js
 *   curl -X POST localhost:3002/infer-debug/start
 *   curl -H 'infer-debug: 1' localhost:3002/api/orders/42
 *
 * The marked request is answered by the debug child (same file, --inspect),
 * and its response carries the `infer-debug` header with a devtools:// deep
 * link that attaches through this very port.
 */
const fastify = require('fastify')();
const { inferDebugFastifyPlugin } = require('infer-debug/fastify');

// Control API, /json/* discovery, and header-marked proxying become active at
// once; the WS tunnel + port discovery attach in the plugin's onReady hook,
// the child stops in onClose. The core is reachable as fastify.inferDebug.
fastify.register(inferDebugFastifyPlugin, {
  childPortEnvVar: 'APP_PORT',
  healthcheckPath: '/healthcheck',
  childReadyStdoutPattern: /listening on :/i,
});

// --- your app below ---
fastify.get('/api/orders/:id', async (request) => ({ id: request.params.id, pid: process.pid }));
fastify.get('/healthcheck', async () => ({ status: 'ok', pid: process.pid }));

const port = Number(process.env.APP_PORT ?? 3002);
// host 0.0.0.0: reachable from outside a container (Fastify defaults to loopback).
fastify.listen({ port, host: '0.0.0.0' }).then(() => {
  console.log(`listening on :${port} (pid ${process.pid})`);
});
