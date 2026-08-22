#!/usr/bin/env node
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ==================== CONFIG ====================

const DEFAULT_HOST = process.env.INFER_DEBUG_HOST || null;
const DEFAULT_BASE_PATH = process.env.INFER_DEBUG_BASE_PATH || '/infer-debug';
const DEFAULT_PORT = 9229;

// Set in main() once the target is parsed: which protocol to speak and where
// the control API lives on the target.
let SECURE = true;
let BASE_PATH = DEFAULT_BASE_PATH;

const USAGE = `Usage: infer-debug <host> [localPort] [/route ...]

  host        Target host, or set INFER_DEBUG_HOST.
              - full URL (https://api.example.com)  → that scheme is honored
              - bare host (api.example.com)         → https for remote, http for localhost
              - self-signed certs are tolerated for https
  localPort   Local proxy port for chrome://inspect (default ${DEFAULT_PORT}).
  /route      Endpoint(s) to route into the debug child, e.g. '/api/orders/{id}'
  --base-path=/custom   Control API prefix if the server overrode it
                        (or set INFER_DEBUG_BASE_PATH; default /infer-debug)

Examples:
  infer-debug localhost:3000 '/api/orders/{id}'
  infer-debug https://api.example.com 9229 '/api/orders/{*}'
  infer-debug http://staging.internal:8080 '/your-debugged-url'`;

// ==================== ARGUMENT PARSING ====================

function parseArgs(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help') || args[0] === 'help') {
    console.log(USAGE);
    process.exit(0);
  }

  let host = null;
  let hostPort = null;
  let secure = null;
  let localPort = null;
  let basePath = DEFAULT_BASE_PATH;
  const routes = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // --base-path=/custom
    if (arg.startsWith('--base-path=')) {
      basePath = arg.slice('--base-path='.length);
      continue;
    }

    // Any other --flag is unknown — fail loudly instead of misreading it.
    if (arg.startsWith('--')) {
      failUsage(`Unknown option '${arg}'`);
    }

    // Number = local port
    if (!isNaN(Number(arg)) && arg.trim() !== '') {
      if (localPort === null) {
        localPort = Number(arg);
      } else {
        failUsage(`'${arg}' doesn't look like a route — routes must start with '/'`);
      }
      continue;
    }

    // Starts with / = route
    if (arg.startsWith('/')) {
      routes.push(arg);
      continue;
    }

    // Otherwise = host URL (first) or route as a full URL (subsequent)
    if (host === null) {
      const parsed = extractHost(arg);
      host = parsed.hostname;
      hostPort = parsed.port;
      secure = parsed.secure;
    } else if (/^https?:\/\//.test(arg)) {
      routes.push(extractRoute(arg));
    } else {
      failUsage(`'${arg}' doesn't look like a route — routes must start with '/' (e.g. '/api/orders/{id}')`);
    }
  }

  return {
    host: host || DEFAULT_HOST,
    hostPort,
    secure,
    localPort: localPort || DEFAULT_PORT,
    basePath,
    routes,
  };
}

function failUsage(message) {
  console.error(`[InferDebug] ${message}\n`);
  console.error(USAGE);
  process.exit(1);
}

function extractHost(input) {
  try {
    const url = new URL(input);
    // 'host:port' without scheme parses as scheme 'host' with empty hostname — reject it
    if (!url.hostname) {
      throw new Error('no hostname');
    }
    return {
      hostname: url.hostname,
      port: url.port ? Number(url.port) : null,
      secure: url.protocol === 'https:' ? true : url.protocol === 'http:' ? false : null,
    };
  } catch {
    const withoutProto = input.replace(/^https?:\/\//, '');
    const [hostPart, portPart] = withoutProto.split('/')[0].split(':');
    return {
      hostname: hostPart,
      port: portPart ? Number(portPart) : null,
      secure: null,
    };
  }
}

function extractRoute(input) {
  try {
    const url = new URL(input);
    return url.pathname;
  } catch {
    return input;
  }
}

// ==================== HTTP CLIENT ====================

function requestJson(hostname, port, protocol, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const client = protocol === 'https:' ? https : http;
    const options = {
      hostname,
      port,
      path,
      method,
      headers: { host: hostname },
      rejectUnauthorized: false,
    };

    if (body) {
      options.headers['Content-Type'] = 'text/plain';
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Timeout'));
    });

    if (body) req.write(body);
    req.end();
  });
}

function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

async function tryRequest(hostname, targetPort, path, method = 'GET', body = null) {
  const protocol = SECURE ? 'https:' : 'http:';
  return await requestJson(hostname, targetPort, protocol, path, method, body);
}

// ==================== ORCHESTRATION ====================

function resolveTargetPort(hostname, explicitPort) {
  if (explicitPort) return explicitPort;
  if (isLocalhost(hostname)) {
    return process.env.APP_PORT ? Number(process.env.APP_PORT) : 80;
  }
  return SECURE ? 443 : 80;
}

async function main() {
  const { host, hostPort, secure, localPort, basePath, routes } = parseArgs(process.argv);

  if (!host) {
    console.error(USAGE);
    process.exit(1);
  }

  // Scheme: explicit URL scheme wins; otherwise http for localhost, https for remote.
  SECURE = secure ?? !isLocalhost(host);
  BASE_PATH = basePath;

  const targetPort = resolveTargetPort(host, hostPort);

  console.log(`[InferDebug] Target: ${SECURE ? 'https' : 'http'}://${host}:${targetPort}`);
  console.log(`[InferDebug] Local port: ${localPort}`);
  console.log(`[InferDebug] Control API base path: ${BASE_PATH}`);
  if (routes.length) console.log(`[InferDebug] Routes: ${routes.join(', ')}`);

  // 1. Pre-flight check
  console.log('[InferDebug] Checking debug-ability...');
  const ability = await checkDebugAbility(host, targetPort);
  if (ability.status === 'ok') {
    console.log(`[InferDebug] Debug-ability: ok`);
  } else {
    console.log(`[InferDebug] Debug-ability: no, reason: ${ability.reason}`);
    if (ability.reason === 'already running') {
      console.log(`[InferDebug] Server already running, will connect to existing session`);
    } else if (ability.reason === 'debugger attached') {
      console.error(`[InferDebug] Another debugger is already attached. Close existing DevTools session first.`);
      process.exit(1);
    } else {
      console.error(`[InferDebug] Cannot start: ${ability.reason}`);
      process.exit(1);
    }
  }

  // 2. Discovery phase
  console.log('[InferDebug] --- Discovery ---');
  await printEndpoint(host, targetPort, `${BASE_PATH}/status`, 'Status');

  // 3. Start phase
  if (ability.status === 'ok') {
    console.log('[InferDebug] --- Starting debug session ---');
    await startDebugSession(host, targetPort);
  } else {
    console.log('[InferDebug] --- Skipping start (already running) ---');
  }

  // 4. Post-start discovery
  console.log('[InferDebug] --- Inspector ---');
  await printEndpoint(host, targetPort, '/json/version', 'Inspector version');
  await printEndpoint(host, targetPort, '/json/list', 'Inspector list');

  // 5. Post-start logs
  console.log('[InferDebug] --- Latest logs ---');
  await printEndpoint(host, targetPort, `${BASE_PATH}/logs?lines=3`, 'Logs');

  // 5. Route configuration
  if (routes.length > 0) {
    console.log('[InferDebug] --- Configuring routes ---');
    await configureRoutes(host, targetPort, routes);
  }

  // 6. Start proxy
  console.log('[InferDebug] --- Starting local proxy ---');
  startLocalProxy(host, targetPort, localPort);
}

async function checkDebugAbility(hostname, targetPort) {
  try {
    const { status, data } = await tryRequest(hostname, targetPort, `${BASE_PATH}/available`);
    if (status === 200) {
      return JSON.parse(data);
    }
    return { status: 'no', reason: `HTTP ${status}` };
  } catch {
    return { status: 'no', reason: 'server unreachable' };
  }
}

async function printEndpoint(hostname, targetPort, path, label) {
  try {
    const { status, data } = await tryRequest(hostname, targetPort, path);
    if (status === 200) {
      console.log(`[InferDebug] ${label}: ${data.trim()}`);
    } else {
      console.log(`[InferDebug] ${label}: HTTP ${status}`);
    }
  } catch (err) {
    console.log(`[InferDebug] ${label}: ${err.message}`);
  }
}

async function startDebugSession(hostname, targetPort) {
  await tryRequest(hostname, targetPort, `${BASE_PATH}/start`, 'POST');

  for (let i = 0; i < 12; i++) {
    await sleep(10000);
    const { data } = await tryRequest(hostname, targetPort, `${BASE_PATH}/status`);
    const statusText = data.trim();
    console.log(`[InferDebug] Attempt ${i + 1}: ${statusText}`);

    if (statusText.startsWith('running')) {
      console.log('[InferDebug] Debug session is running');
      return;
    }

    if (statusText.includes('zombie') || statusText.includes('error')) {
      throw new Error(`Failed to start: ${statusText}`);
    }
  }

  throw new Error('Timeout waiting for debug session to start');
}

async function configureRoutes(hostname, targetPort, newRoutes) {
  const { data: currentData } = await tryRequest(hostname, targetPort, `${BASE_PATH}/routes`);
  const currentRoutes = currentData.trim().split('\n').filter((r) => r);
  console.log(`[InferDebug] Current routes: ${currentRoutes.join(', ') || '(none)'}`);

  const merged = [...new Set([...currentRoutes, ...newRoutes])];
  const body = merged.join('\n');

  const { data } = await tryRequest(hostname, targetPort, `${BASE_PATH}/routes`, 'POST', body);
  console.log(`[InferDebug] Updated routes: ${data.trim().split('\n').join(', ')}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ==================== LOCAL PROXY ====================

function startLocalProxy(targetHost, targetPort, sourcePort) {
  const targetProtocol = SECURE ? 'https' : 'http';
  const client = SECURE ? https : http;

  let inspectorPath = null;
  let lastFetch = 0;
  const FETCH_INTERVAL = 30000;

  function fetchJson(path) {
    return new Promise((resolve, reject) => {
      const req = client.get(
        {
          hostname: targetHost,
          port: targetPort,
          path,
          headers: { host: targetHost },
          rejectUnauthorized: false,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode, data }));
        },
      );
      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Timeout'));
      });
    });
  }

  async function discoverInspector() {
    const now = Date.now();
    if (inspectorPath && now - lastFetch < FETCH_INTERVAL) {
      return inspectorPath;
    }

    try {
      const { status, data } = await fetchJson('/json/list');
      if (status !== 200) throw new Error(`HTTP ${status}`);

      const list = JSON.parse(data);
      if (list && list[0] && list[0].id) {
        inspectorPath = `/${list[0].id}`;
        lastFetch = now;
        console.log(`[InferDebug] Discovered inspector: ${inspectorPath}`);
        return inspectorPath;
      }
      throw new Error('No inspector ID in response');
    } catch (err) {
      console.error('[InferDebug] Discovery failed:', err.message);
      throw err;
    }
  }

  const server = http.createServer((req, res) => {
    const proxyReq = client.request(
      {
        hostname: targetHost,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: targetHost },
        rejectUnauthorized: false,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      console.error('[InferDebug] HTTP error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    req.pipe(proxyReq);
  });

  server.on('upgrade', async (request, socket, head) => {
    let path = request.url;

    if (path === '/debug') {
      try {
        path = await discoverInspector();
      } catch {
        console.error('[InferDebug] No inspector discovered for /debug');
        socket.destroy();
        return;
      }
    }

    const wsProto = SECURE ? 'wss' : 'ws';
    console.log(`[InferDebug] WS upgrade ${request.url} -> ${wsProto}://${targetHost}${path}`);

    const wsReq = client.request({
      hostname: targetHost,
      port: targetPort,
      path,
      method: request.method,
      headers: { ...request.headers, host: targetHost },
      rejectUnauthorized: false,
    });

    wsReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      if (proxyRes.statusCode !== 101) {
        console.error(`[InferDebug] WS upgrade failed: ${proxyRes.statusCode}`);
        socket.destroy();
        return;
      }

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

      proxySocket.on('close', () => socket.end());
      socket.on('close', () => proxySocket.end());
      proxySocket.on('error', (err) => console.error('[InferDebug] remote error:', err.message));
      socket.on('error', (err) => console.error('[InferDebug] client error:', err.message));
    });

    wsReq.on('error', (err) => {
      console.error('[InferDebug] WS request error:', err.message);
      socket.destroy();
    });

    wsReq.on('response', (res) => {
      console.error(`[InferDebug] WS got HTTP ${res.statusCode} instead of 101`);
      if (res.statusCode === 404) {
        console.log('[InferDebug] Clearing cached inspector path, will rediscover');
        inspectorPath = null;
      }
      socket.destroy();
    });

    request.pipe(wsReq);
  });

  server.listen(sourcePort, () => {
    const proto = SECURE ? 'https' : 'http';
    console.log(`[InferDebug] Listening on http://127.0.0.1:${sourcePort}`);
    console.log(`[InferDebug] Forwarding to ${proto}://${targetHost}`);
    console.log(`[InferDebug] Configure chrome://inspect with 127.0.0.1:${sourcePort}`);
    console.log(`[InferDebug] Or: devtools://devtools/bundled/inspector.html?ws=127.0.0.1:${sourcePort}/debug`);
  });
}

// ==================== MAIN ====================

main().catch((err) => {
  console.error('[InferDebug] Fatal error:', err.message);
  process.exit(1);
});
