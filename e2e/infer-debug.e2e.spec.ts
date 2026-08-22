import { ChildProcess, spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { CdpClient } from './cdp-client';

/**
 * End-to-end proof that the package does its job on a live app:
 *
 *   1. fixture app boots with InferDebugModule (INFER_DEBUG=true)
 *   2. a registered route is proxied to the spawned debug child (pid changes)
 *   3. non-registered routes stay on the main process
 *   4. Chrome DevTools discovery (/json/list) works through the app port
 *   5. a REAL debugger session runs through the proxy: CDP connect, evaluate,
 *      breakpoint in the orders controller, pause, variable inspection, resume
 *
 * Two run modes:
 *   - local:  spawns e2e/dist/main.js itself (npm run test:e2e)
 *   - remote: E2E_BASE_URL set (docker compose) — talks to an already-running app
 */

jest.setTimeout(180000);

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4123';
const SPAWN_LOCALLY = !process.env.E2E_BASE_URL;
const FIXTURE_MAIN = path.join(__dirname, 'dist', 'main.js');
const ORDERS_CONTROLLER_JS = path.join(__dirname, 'dist', 'orders.controller.js');
const FAULTS_CONTROLLER_JS = path.join(__dirname, 'dist', 'faults.controller.js');

type THttpResult = { status: number; body: string };

function httpRequest(method: string, url: string, body?: string, contentType = 'text/plain'): Promise<THttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: body !== undefined ? { 'Content-Type': contentType } : {} },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

async function waitFor(
  description: string,
  check: () => Promise<boolean>,
  timeoutMs = 60000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timeout waiting for: ${description}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('infer-debug e2e', () => {
  let fixture: ChildProcess | null = null;
  const fixtureOutput: string[] = [];
  let mainPid = -1;
  let childPid = -1;
  let wsPath = '';
  let cdp: CdpClient | null = null;

  beforeAll(async () => {
    if (SPAWN_LOCALLY) {
      if (!fs.existsSync(FIXTURE_MAIN)) {
        throw new Error(`Fixture not built: ${FIXTURE_MAIN} — run "npm run build:e2e" first`);
      }
      fixture = spawn(process.execPath, [FIXTURE_MAIN], {
        env: {
          ...process.env,
          APP_PORT: '4123',
          INFER_DEBUG: 'true',
          // Same as the production convention: stacks must show .ts sources.
          // The debug child inherits it through process.env.
          NODE_OPTIONS: '--enable-source-maps',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fixture.stdout?.on('data', (d) => fixtureOutput.push(String(d)));
      fixture.stderr?.on('data', (d) => fixtureOutput.push(String(d)));
    }

    try {
      await waitFor('fixture app healthcheck', async () => {
        try {
          const res = await httpRequest('GET', `${BASE_URL}/healthcheck`);
          return res.status === 200;
        } catch {
          return false;
        }
      });
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- fixture output ---\n${fixtureOutput.join('')}`);
    }
  });

  afterAll(async () => {
    cdp?.close();
    if (childPid !== -1) {
      await httpRequest('POST', `${BASE_URL}/infer-debug/stop`).catch(() => undefined);
    }
    if (fixture) {
      fixture.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

  it('reports debug availability', async () => {
    const res = await httpRequest('GET', `${BASE_URL}/infer-debug/available`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
  });

  it('serves business routes on the main process before any session', async () => {
    const res = await httpRequest('GET', `${BASE_URL}/api/orders/1`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('1');
    mainPid = body.pid;
    expect(mainPid).toBeGreaterThan(0);
    if (SPAWN_LOCALLY) {
      expect(mainPid).toBe(fixture?.pid);
    }
  });

  it('registers routes and starts the debug child', async () => {
    // NestJS answers POST with 201 by default; any 2xx is success here.
    const routes = await httpRequest('POST', `${BASE_URL}/infer-debug/routes`, '/api/orders/{*}\n/api/faults/{*}');
    expect(routes.status).toBeGreaterThanOrEqual(200);
    expect(routes.status).toBeLessThan(300);
    expect(routes.body).toContain('/api/orders/{*}');
    expect(routes.body).toContain('/api/faults/{*}');

    await httpRequest('POST', `${BASE_URL}/infer-debug/start`);
    await waitFor('child status = running', async () => {
      const res = await httpRequest('GET', `${BASE_URL}/infer-debug/status`);
      return res.body.startsWith('running');
    });
  });

  it('proxies registered routes to the child process', async () => {
    const res = await httpRequest('GET', `${BASE_URL}/api/orders/1`);
    expect(res.status).toBe(200);
    childPid = JSON.parse(res.body).pid;
    expect(childPid).toBeGreaterThan(0);
    expect(childPid).not.toBe(mainPid);
  });

  it('keeps non-registered routes on the main process', async () => {
    const res = await httpRequest('GET', `${BASE_URL}/healthcheck`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).pid).toBe(mainPid);
  });

  it('exposes Chrome DevTools discovery through the app port', async () => {
    const res = await httpRequest('GET', `${BASE_URL}/json/list`);
    expect(res.status).toBe(200);
    const targets = JSON.parse(res.body);
    expect(Array.isArray(targets)).toBe(true);
    const target = targets.find((t: { webSocketDebuggerUrl?: string }) => t.webSocketDebuggerUrl);
    expect(target).toBeDefined();
    wsPath = new URL(target.webSocketDebuggerUrl).pathname;
    expect(wsPath.length).toBeGreaterThan(1);
  });

  it('drives a real debugger session through the proxy (CDP)', async () => {
    const { host } = new URL(BASE_URL);
    cdp = await CdpClient.connect(`ws://${host}${wsPath}`);

    // 1. Basic protocol: evaluate in the child process.
    const evaluated = await cdp.send('Runtime.evaluate', { expression: '1 + 1', returnByValue: true });
    expect(evaluated.result.value).toBe(2);

    // 2. Find the orders controller among parsed scripts.
    const scriptUrls: string[] = [];
    cdp.on('Debugger.scriptParsed', (params) => scriptUrls.push(params.url));
    await cdp.send('Debugger.enable');
    await waitFor('orders controller script parsed', async () =>
      scriptUrls.some((url) => url.endsWith('/orders.controller.js')),
    );
    const scriptUrl = scriptUrls.find((url) => url.endsWith('/orders.controller.js'))!;

    // 3. Breakpoint on the getOrder handler (line looked up in the built file;
    //    V8 slides it to the first executable statement of the function).
    const compiled = fs.readFileSync(ORDERS_CONTROLLER_JS, 'utf8').split('\n');
    const line = compiled.findIndex((l) => /getOrder\(/.test(l));
    expect(line).toBeGreaterThanOrEqual(0);
    const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', { url: scriptUrl, lineNumber: line });
    expect(breakpoint.breakpointId).toBeDefined();

    // 4. Trigger the proxied route — the child must pause inside getOrder.
    //    Note: Node's inspector leaves callFrames[].url EMPTY in paused events,
    //    so we assert on functionName + our breakpointId in hitBreakpoints.
    const pendingResponse = httpRequest('GET', `${BASE_URL}/api/orders/42`);
    try {
      const paused = await cdp.waitForEvent('Debugger.paused');
      expect(paused.callFrames[0].functionName).toBe('getOrder');
      expect(paused.hitBreakpoints).toContain(breakpoint.breakpointId);

      // 5. Inspect a live variable in the paused frame — the route parameter.
      const frameId = paused.callFrames[0].callFrameId;
      const variable = await cdp.send('Debugger.evaluateOnCallFrame', {
        callFrameId: frameId,
        expression: 'id',
        returnByValue: true,
      });
      expect(variable.result.value).toBe('42');
    } finally {
      // Always release the child — a stuck pause would hang pendingResponse and
      // poison the rest of the suite with 'socket hang up'.
      await cdp.send('Debugger.resume').catch(() => undefined);
    }

    // 6. The client gets its response as if nothing happened.
    const res = await pendingResponse;
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: '42', pid: childPid });

    // Node's inspector serves one CDP client at a time — release it so the
    // next test can attach its own session.
    cdp.close();
    cdp = null;
  });

  it('captures process-level faults with a TypeScript tracepath (source maps)', async () => {
    // Fresh CDP session (the previous test released its connection).
    const { host } = new URL(BASE_URL);
    cdp = await CdpClient.connect(`ws://${host}${wsPath}`);

    const scriptUrls: string[] = [];
    cdp.on('Debugger.scriptParsed', (params) => scriptUrls.push(params.url));
    await cdp.send('Debugger.enable');
    await waitFor('faults controller script parsed', async () =>
      scriptUrls.some((url) => url.endsWith('/faults.controller.js')),
    );
    const scriptUrl = scriptUrls.find((url) => url.endsWith('/faults.controller.js'))!;
    const compiled = fs.readFileSync(FAULTS_CONTROLLER_JS, 'utf8').split('\n');

    // ---------- uncaughtException ----------
    // Breakpoint inside detonateUncaught: the throw is deferred via setTimeout,
    // so the POST responds first and the pause arrives after.
    const uncaughtLine = compiled.findIndex((l) => /function detonateUncaught/.test(l));
    expect(uncaughtLine).toBeGreaterThanOrEqual(0);
    const bp1 = await cdp.send('Debugger.setBreakpointByUrl', { url: scriptUrl, lineNumber: uncaughtLine });
    expect(bp1.breakpointId).toBeDefined();

    const scheduled1 = await httpRequest('POST', `${BASE_URL}/api/faults/uncaught`);
    expect(scheduled1.status).toBeLessThan(300);

    try {
      const paused = await cdp.waitForEvent('Debugger.paused');
      expect(paused.callFrames[0].functionName).toBe('detonateUncaught');
      expect(paused.hitBreakpoints).toContain(bp1.breakpointId);
    } finally {
      await cdp.send('Debugger.resume').catch(() => undefined);
    }

    // The child's process-level handler logs the stack — read it back through
    // the parent's log buffer. With --enable-source-maps + inlineSourceMap the
    // frames must point at the .ts SOURCE, which is the tracepath evidence.
    await waitFor('uncaughtException captured in child logs', async () => {
      const logs = await httpRequest('GET', `${BASE_URL}/infer-debug/logs?lines=200`);
      return logs.body.includes('uncaughtException captured') && logs.body.includes('e2e-boom-uncaught');
    });
    const uncaughtLogs = await httpRequest('GET', `${BASE_URL}/infer-debug/logs?lines=200`);
    expect(uncaughtLogs.body).toMatch(/faults\.controller\.ts:\d+/);

    // ---------- unhandledRejection ----------
    const unhandledLine = compiled.findIndex((l) => /function detonateUnhandled/.test(l));
    expect(unhandledLine).toBeGreaterThanOrEqual(0);
    const bp2 = await cdp.send('Debugger.setBreakpointByUrl', { url: scriptUrl, lineNumber: unhandledLine });
    expect(bp2.breakpointId).toBeDefined();

    const pendingFault = httpRequest('POST', `${BASE_URL}/api/faults/unhandled`);
    try {
      const paused = await cdp.waitForEvent('Debugger.paused');
      expect(paused.callFrames[0].functionName).toBe('detonateUnhandled');
      expect(paused.hitBreakpoints).toContain(bp2.breakpointId);
    } finally {
      await cdp.send('Debugger.resume').catch(() => undefined);
    }
    const scheduled2 = await pendingFault;
    expect(scheduled2.status).toBeLessThan(300);

    await waitFor('unhandledRejection captured in child logs', async () => {
      const logs = await httpRequest('GET', `${BASE_URL}/infer-debug/logs?lines=200`);
      return logs.body.includes('unhandledRejection captured') && logs.body.includes('e2e-boom-unhandled');
    });
    const unhandledLogs = await httpRequest('GET', `${BASE_URL}/infer-debug/logs?lines=200`);
    expect(unhandledLogs.body).toMatch(/faults\.controller\.ts:\d+/);

    // Both faults were captured by process-level handlers — nothing crashed.
    const health = await httpRequest('GET', `${BASE_URL}/healthcheck`);
    expect(health.status).toBe(200);
  });
});
