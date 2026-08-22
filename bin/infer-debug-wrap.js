#!/usr/bin/env node
/**
 * infer-debug-wrap — the "wrap" alternative to the in-process module.
 *
 * Instead of embedding InferDebugModule into your app, this standalone script
 * spawns your app itself under --inspect and proxies EVERYTHING to it:
 * all HTTP traffic, inspector discovery (/json/*), and all WebSocket upgrades.
 *
 * Use it when you want every request to hit the debugged process (no route
 * selectivity), e.g. local debugging sessions.
 *
 * Usage:
 *   infer-debug-wrap [entry] [externalPort]
 *     entry         App entry file (default: env APP_ENTRY or dist/src/main)
 *     externalPort  Public port (default: env APP_PORT, then APP_PORT from ./.env, then 3000)
 *
 * The app always runs on externalPort + 1, the inspector on 9229.
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

function getEnvPort() {
  if (process.env.APP_PORT) {
    return parseInt(process.env.APP_PORT, 10);
  }
  let envPort = 3000;
  try {
    const envContent = fs.readFileSync('.env', 'utf8');
    const match = envContent.match(/APP_PORT\s*=\s*(\d+)/);
    if (match) envPort = parseInt(match[1], 10);
  } catch (_e) {}
  return envPort;
}

const ENTRY = process.argv[2] || process.env.APP_ENTRY || 'dist/src/main';
const EXTERNAL_PORT = process.argv[3] ? parseInt(process.argv[3], 10) : getEnvPort();
const INTERNAL_PORT = EXTERNAL_PORT + 1;
const INSPECTOR_PORT = process.env.INSPECTOR_PORT ? parseInt(process.env.INSPECTOR_PORT, 10) : 9229;
const MAX_RETRIES = 10;

let child = null;

function startApp(attempt) {
  if (attempt > MAX_RETRIES) {
    console.error('[Wrap] No available ports. Exiting.');
    process.exit(1);
  }

  const currentInternal = INTERNAL_PORT + attempt - 1;

  child = spawn('node', [`--inspect=${INSPECTOR_PORT}`, ENTRY], {
    env: { ...process.env, APP_PORT: String(currentInternal) },
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    console.log(`[Wrap] App exited with code ${code}`);
    process.exit(code ?? 0);
  });

  startServer(currentInternal);
}

function proxyHttp(req, res, targetHost, targetPort, headers) {
  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: headers || req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    console.error('[Wrap] Proxy error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Bad Gateway');
    }
  });

  req.pipe(proxyReq);
}

function startServer(appPort) {
  const server = http.createServer((req, res) => {
    // Inspector discovery endpoints → inspector (with host override)
    if (req.url === '/json/version' || req.url === '/json/list') {
      const inspectorHeaders = { ...req.headers, host: `127.0.0.1:${INSPECTOR_PORT}` };
      proxyHttp(req, res, '127.0.0.1', INSPECTOR_PORT, inspectorHeaders);
      return;
    }

    // Everything else → app (preserve original headers)
    proxyHttp(req, res, '127.0.0.1', appPort);
  });

  // WebSocket upgrades → inspector (any path, including UUID)
  server.on('upgrade', (request, socket, head) => {
    const wsReq = http.request({
      hostname: '127.0.0.1',
      port: INSPECTOR_PORT,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${INSPECTOR_PORT}` },
    });

    wsReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      proxySocket.pipe(socket);
      socket.pipe(proxySocket);
      proxySocket.write(proxyHead);
    });

    wsReq.on('error', (err) => {
      console.error('[Wrap] WS error:', err.message);
      socket.destroy();
    });

    request.pipe(wsReq);
  });

  server.listen(EXTERNAL_PORT, () => {
    console.log(`[Wrap] Entry: ${ENTRY}`);
    console.log(`[Wrap] HTTP proxy: http://localhost:${EXTERNAL_PORT} -> http://localhost:${appPort}`);
    console.log(`[Wrap] Inspector discovery: http://localhost:${EXTERNAL_PORT}/json/* -> http://localhost:${INSPECTOR_PORT}/json/*`);
    console.log(`[Wrap] WS proxy: ws://localhost:${EXTERNAL_PORT}/* -> ws://localhost:${INSPECTOR_PORT}/*`);
  });
}

process.on('SIGTERM', () => {
  if (child) child.kill('SIGTERM');
});
process.on('SIGINT', () => {
  if (child) child.kill('SIGINT');
});

startApp(1);
