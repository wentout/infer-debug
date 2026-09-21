/**
 * Express usage of infer-debug — one middleware plus attachServer.
 *
 *   INFER_DEBUG=true node examples/express/server.js
 *   curl -X POST localhost:3001/infer-debug/start
 *   curl -H 'infer-debug: 1' localhost:3001/api/orders/42
 *
 * The marked request is answered by the debug child (same file, --inspect),
 * and its response carries the `infer-debug` header with a devtools:// deep
 * link that attaches through this very port.
 */
const express = require('express');
const { InferDebugCore } = require('infer-debug');
const { createInferDebugMiddleware } = require('infer-debug/express');

const core = new InferDebugCore({
  childPortEnvVar: 'APP_PORT',
  healthcheckPath: '/healthcheck',
  childReadyStdoutPattern: /listening on :/i,
});

const app = express();

// infer-debug first: control API, /json/* discovery, header-marked requests.
app.use(createInferDebugMiddleware(core));

// --- your app below ---
app.get('/api/orders/:id', (req, res) => {
  res.json({ id: req.params.id, pid: process.pid });
});
app.get('/healthcheck', (_req, res) => {
  res.json({ status: 'ok', pid: process.pid });
});

const port = Number(process.env.APP_PORT ?? 3001);
const server = app.listen(port, () => {
  // Port discovery (child = port + 1) + the inspector WS upgrade hook.
  core.attachServer(server);
  console.log(`listening on :${port} (pid ${process.pid})`);
});

// exit() matters: the debug child runs this same file — a SIGTERM handler
// that only closes the core would keep the child alive forever (zombie).
const shutdown = () => {
  core.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
