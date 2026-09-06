/**
 * Raw Node.js usage of infer-debug — no framework at all.
 *
 *   INFER_DEBUG=true node examples/raw-node/server.js
 *   curl -X POST localhost:3000/infer-debug/start
 *   curl -H 'infer-debug: 1' localhost:3000/api/orders/42
 *
 * The marked request is answered by the debug child (same file, --inspect),
 * and its response carries the `infer-debug` header with a devtools:// deep
 * link that attaches through this very port.
 */
const http = require('http');
const { InferDebugCore } = require('infer-debug');

const core = new InferDebugCore({ childPortEnvVar: 'APP_PORT' });

const server = http.createServer((req, res) => {
  // infer-debug first: control API, /json/* discovery, header-marked requests.
  const handled = core.handleHttp(req, res);
  if (handled) {
    return;
  }

  // --- your app below ---
  if (req.url === '/api/orders/42') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: '42', pid: process.pid }));
    return;
  }
  res.writeHead(404);
  res.end('Not Found');
});

const port = Number(process.env.APP_PORT ?? 3000);
server.listen(port, () => {
  // Port discovery (child = port + 1) + the inspector WS upgrade hook.
  core.attachServer(server);
  console.log(`listening on :${port} (pid ${process.pid})`);
});

process.on('SIGTERM', () => core.close());
process.on('SIGINT', () => core.close());
