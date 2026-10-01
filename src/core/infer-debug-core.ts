import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { Transform, Duplex } from 'stream';
import { CircularBuffer } from '../models/circular-buffer';
import { buildDevtoolsJumpUrl } from '../models/devtools-url';
import { TInferDebugOptions, TResolvedInferDebugOptions, resolveInferDebugOptions } from '../infer-debug.options';
import { TRequestLike, TResponseLike, TInferDebugLogger, consoleInferDebugLogger } from './http-like';
import { matchControlRoute, handleControlRequest } from './control-api';

export type TInferDebugStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type TZombieInfo = 'no zombie' | 'has zombie';

const INSPECTOR_TARGET_PATH = /^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The WS tunnel accepts only inspector-shaped upgrade paths: `/<target-uuid>` —
 * the same id `/json/list` reports and the jump link embeds. This is ROUTING,
 * not security: it keeps the host app's own WebSockets (socket.io etc.) from
 * being tunnelled to the inspector while the child is ready. The header trigger
 * does not apply here on purpose — DevTools cannot send custom headers on its
 * WebSocket handshake, so the jump link would break.
 */
export function isInspectorUpgradePath(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const path = url.split('?')[0];
  const result = INSPECTOR_TARGET_PATH.test(path);
  return result;
}

/**
 * The framework-free heart of infer-debug: debug-child lifecycle, request
 * proxying, inspector WS tunnel, log buffer, auto-stop. No framework imports —
 * adapters (NestJS module, Express middleware, Fastify plugin, or manual
 * wiring on a raw http.Server) are thin shells around this class.
 *
 * Raw-Node usage:
 *   const core = new InferDebugCore(options);
 *   const server = http.createServer((req, res) => {
 *     if (core.handleHttp(req, res)) return;
 *     // ... your app ...
 *   });
 *   server.listen(3000, () => core.attachServer(server)); // port discovery + WS hook
 */
export class InferDebugCore {
  protected readonly logger: TInferDebugLogger;
  protected child: ChildProcess | null = null;
  protected childPort: number | null = null;
  protected inspectorTargetId: string | null = null;
  protected isChildReady = false;
  protected status: TInferDebugStatus = 'stopped';
  protected readonly logBuffer: CircularBuffer<string>;
  protected lastActivityAt = Date.now();
  protected lastActivitySource = 'none';
  protected readonly options: TResolvedInferDebugOptions;

  constructor(options: TInferDebugOptions = {}, logger: TInferDebugLogger = consoleInferDebugLogger) {
    this.logger = logger;
    this.options = resolveInferDebugOptions(options);
    this.logBuffer = new CircularBuffer<string>(this.options.logBufferSize);
    if (this.options.enabled) {
      // unref: the interval must never keep a short-lived process (CLI runs,
      // tests) alive on its own — a real server holds the event loop anyway.
      const timer = setInterval(() => {
        if (this.status !== 'running') {
          return;
        }
        const idleTime = Date.now() - this.lastActivityAt;
        const t1 = Math.round(idleTime / 1000);
        const t2 = this.options.idleTimeoutMs / 1000;
        if (idleTime >= this.options.idleTimeoutMs) {
          this.logger.log(`[InferDebug] Idle for ${t1}s of ${t2}s, auto-stopping child`);
          void this.autoStopWithZombieCheck();
        } else {
          this.logger.log(`[InferDebug] Activity present: idle for ${t1}s of ${t2}s (last: ${this.lastActivitySource})`);
        }
      }, this.options.idleCheckIntervalMs);
      timer.unref();
    }
  }

  /**
   * Attach to the host HTTP server: discovers the app port (child gets
   * appPort + 1 unless pinned) and installs the inspector WS upgrade hook.
   * Call once the server object exists; discovery waits for `listening`
   * internally when the server is not bound yet.
   */
  attachServer(httpServer: http.Server): void {
    if (!this.options.enabled) {
      return;
    }

    if (this.options.childPort !== undefined) {
      this.childPort = this.options.childPort;
      this.logger.log(`[InferDebug] Child port pinned by option: ${this.childPort}`);
    } else {
      // The port is only known once the server is listening; child spawn always
      // happens later (on POST <basePath>/start), so either path is safe.
      this.childPort = this.readBoundPort(httpServer);
      if (this.childPort === null) {
        httpServer.once('listening', () => {
          this.childPort = this.readBoundPort(httpServer);
          this.logger.log(`[InferDebug] Discovered app port ${this.childPort! - 1}, child will use ${this.childPort}`);
        });
      }
    }

    httpServer.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  /** Stop the debug child. Adapters call this from their shutdown hook. */
  close(): void {
    this.stopChild();
  }

  private readBoundPort(httpServer: http.Server): number | null {
    const address = httpServer.address();
    if (address && typeof address === 'object') {
      return address.port + 1;
    }
    return null;
  }

  isEnabled(): boolean {
    return this.options.enabled;
  }

  getBasePath(): string {
    return this.options.basePath;
  }

  getChildStatus(): TInferDebugStatus {
    const pid = this.child?.pid;
    const osProcessAlive = pid ? this.isProcessAlive(pid) : false;

    if (!osProcessAlive && (this.status === 'starting' || this.status === 'running' || this.status === 'stopping')) {
      this.status = 'stopped';
      this.isChildReady = false;
      this.child = null;
    }

    return this.status;
  }

  hasZombie(): TZombieInfo {
    const pid = this.child?.pid;
    if (!pid) {
      return 'no zombie';
    }
    if (!this.isProcessAlive(pid)) {
      return 'no zombie';
    }
    // Zombie = process alive after we tried to stop it
    if (this.status === 'stopped' || this.status === 'stopping') {
      return 'has zombie';
    }
    return 'no zombie';
  }

  hasActiveDebugger(): boolean {
    const childStatus = this.getChildStatus();
    if (childStatus !== 'running') {
      return false;
    }

    const logs = this.logBuffer.getAll();
    let attached = 0;
    let ended = 0;
    for (const line of logs) {
      if (line.includes('Debugger attached.')) {
        attached++;
      }
      if (line.includes('Debugger ending on ws://')) {
        ended++;
      }
    }
    return attached > ended;
  }

  getDebugAbility(): { status: string; reason?: string } {
    if (!this.options.enabled) {
      return { status: 'no', reason: 'disabled' };
    }
    if (this.hasZombie() === 'has zombie') {
      return { status: 'no', reason: 'zombie present' };
    }
    const childStatus = this.getChildStatus();
    if (childStatus === 'running' || childStatus === 'starting') {
      if (this.hasActiveDebugger()) {
        return { status: 'no', reason: 'debugger attached' };
      }
      return { status: 'ok' };
    }
    return { status: 'ok' };
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  touchActivity(source: string): void {
    this.lastActivityAt = Date.now();
    this.lastActivitySource = source;
    this.logger.log(`[InferDebug] Activity from ${source}`);
  }

  async startChild(): Promise<void> {
    if (this.status === 'starting' || this.status === 'running') {
      this.logger.log(`[InferDebug] Start ignored: already ${this.status}`);
      return;
    }
    if (this.hasZombie() === 'has zombie') {
      this.logger.error('[InferDebug] Start refused: zombie process detected, cannot start new child');
      return;
    }
    if (this.childPort === null) {
      this.logger.error('[InferDebug] Start refused: app port not discovered yet (server not listening?)');
      return;
    }

    this.status = 'starting';
    const env = { ...process.env, [this.options.childPortEnvVar]: String(this.childPort) };

    this.child = spawn('node', [`--inspect=${this.options.inspectorPort}`, this.options.childEntry], {
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });

    this.child.on('exit', (code) => {
      this.logger.log(`[InferDebug] Child exited with code ${code}`);
      this.child = null;
      this.isChildReady = false;
      this.inspectorTargetId = null;
      this.status = 'stopped';
    });

    this.child.on('error', (err) => {
      this.logger.error('[InferDebug] Child spawn error:', err.message);
      this.status = 'stopped';
    });

    const stdoutReady = this.options.childReadyStdoutPattern
      ? this.waitForChildStdout(this.child.stdout, this.options.childReadyStdoutPattern)
      : Promise.resolve();
    this.child.stdout?.pipe(this.createLogBufferTransform()).pipe(this.createPrefixTransform('\x1b[33m[Child]\x1b[0m')).pipe(process.stdout);
    this.child.stderr?.pipe(this.createLogBufferTransform()).pipe(this.createPrefixTransform('\x1b[31m[Child]\x1b[0m')).pipe(process.stderr);

    try {
      await stdoutReady;
      await this.waitForChildHealth();
      this.status = 'running';
      this.touchActivity('startChild');
      // Best-effort (never throws): the jump header stays off until a fetch succeeds.
      await this.fetchInspectorTargetId();
      this.logger.log(`[InferDebug] Child ready on port ${this.childPort}, inspector on ${this.options.inspectorPort}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`[InferDebug] Child failed to become ready, stopping it: ${message}`);
      this.child?.kill('SIGTERM');
      this.child = null;
      this.isChildReady = false;
      this.inspectorTargetId = null;
      this.status = 'stopped';
    }
  }

  stopChild(): void {
    if (this.status === 'stopping' || this.status === 'stopped') {
      this.logger.log(`[InferDebug] Stop ignored: already ${this.status}`);
      return;
    }

    this.status = 'stopping';
    if (this.child) {
      this.child.kill('SIGTERM');
    } else {
      this.status = 'stopped';
    }
  }

  getHeaderName(): string {
    return this.options.headerName;
  }

  /**
   * The trigger-header check — the whole routing decision. Route tables are the
   * app's own concern (a middleware that sets this header for chosen paths —
   * see examples/nest-route-table); the core itself stays route-agnostic.
   */
  isMarkedForDebug(req: TRequestLike): boolean {
    return req.headers?.[this.options.headerName] !== undefined;
  }

  /** Child is up and its HTTP port is known — safe to proxy. */
  isReady(): boolean {
    return this.isChildReady && this.childPort !== null;
  }

  getLogs(lines?: number): string[] {
    if (lines === undefined || lines <= 0) {
      return this.logBuffer.getAll();
    }
    return this.logBuffer.getLast(lines);
  }

  clearLogs(): void {
    this.logBuffer.clear();
  }

  /**
   * Cheap pre-check: will handleHttp definitely answer this request?
   * Adapters with a take-over API (Fastify's reply.hijack()) need this before
   * committing to manual response handling.
   */
  shouldHandle(req: TRequestLike): boolean {
    if (!this.options.enabled) {
      return false;
    }
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (matchControlRoute(this.options.basePath, req.method, path)) {
      return true;
    }
    if (path === '/json/version' || path === '/json/list') {
      return true;
    }
    const marked = this.isMarkedForDebug(req);
    return marked;
  }

  /**
   * The whole request-side of infer-debug in one call. Returns true when the
   * request was answered (control API, inspector discovery, or proxied to the
   * debug child); false means "not ours — pass to the app".
   */
  handleHttp(req: TRequestLike, res: TResponseLike): boolean {
    const handled = this.shouldHandle(req);
    if (!handled) {
      return false;
    }
    const path = (req.originalUrl || req.url || '').split('?')[0];
    if (matchControlRoute(this.options.basePath, req.method, path)) {
      handleControlRequest(this, req, res);
      return true;
    }
    if (path === '/json/version' || path === '/json/list') {
      if (!this.isReady()) {
        res.writeHead(404);
        res.end('Not Found');
        return true;
      }
      this.proxyToInspector(req, res);
      return true;
    }
    this.proxyToChild(req, res, path);
    return true;
  }

  proxyToChild(req: TRequestLike, res: TResponseLike, url?: string): void {
    if (!this.isChildReady || this.childPort === null) {
      res.writeHead(503);
      res.end('Debug proxy child not running');
      return;
    }
    this.touchActivity('proxyToChild');

    // The trigger header is a control signal for the proxy layer, not app data.
    // The child runs the same module (env is inherited), so forwarding it would
    // make the child try to proxy the request to a grandchild that never exists.
    const headers = { ...req.headers };
    delete headers[this.options.headerName];

    const responseHeaders: Record<string, string> = {};
    const jumpUrl = this.buildJumpUrl(req);
    if (jumpUrl !== null) {
      responseHeaders[this.options.headerName] = jumpUrl;
    } else {
      // Self-heal: re-try the discovery so a later response can carry the link.
      void this.fetchInspectorTargetId();
    }

    this.proxyHttp(req, res, '127.0.0.1', this.childPort, headers, url, responseHeaders);
  }

  proxyToInspector(req: TRequestLike, res: TResponseLike): void {
    if (!this.isChildReady) {
      res.writeHead(503);
      res.end('Debug proxy child not running');
      return;
    }
    this.touchActivity('proxyToInspector');
    const headers = { ...req.headers, host: `127.0.0.1:${this.options.inspectorPort}` };
    this.proxyHttp(req, res, '127.0.0.1', this.options.inspectorPort, headers);
  }

  handleUpgrade(request: http.IncomingMessage, socket: Duplex, _head: Buffer): void {
    const inspectorPath = isInspectorUpgradePath(request.url);
    const marked = this.isMarkedForDebug(request);
    if (!inspectorPath && !marked) {
      // Not ours: leave the socket to other upgrade listeners instead of
      // destroying it — the host app may serve its own WebSockets.
      return;
    }
    if (!this.isChildReady || (!inspectorPath && this.childPort === null)) {
      // Inspector probes keep their historical behaviour (silently left;
      // DevTools retries while the child starts). A MARKED upgrade names
      // the secondary explicitly: answer like proxyToChild does instead of
      // leaving the socket in limbo.
      if (inspectorPath) {
        return;
      }
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.touchActivity('handleUpgrade');
    // The uuid path gates DevTools (it cannot send custom headers); the
    // trigger header gates every OTHER upgrade: relayed wholesale to the
    // secondary process, which owns the path (e.g. strategy's /strategy).
    // The header is consumed, never forwarded (invariant 7): the secondary
    // runs the same module and would relay to its own grandchild.
    const relayPort = inspectorPath ? this.options.inspectorPort : this.childPort;
    const headers: Record<string, string | string[] | undefined> = {
      ...request.headers,
      host: `127.0.0.1:${relayPort}`,
    };
    if (!inspectorPath) {
      delete headers[this.options.headerName];
    }
    const wsReq = http.request({
      hostname: '127.0.0.1',
      port: relayPort,
      path: request.url,
      method: request.method,
      headers,
    });

    wsReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write(
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      const trackIn = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          this.touchActivity(inspectorPath ? 'wsDataFromInspector' : 'wsDataFromChild');
          cb(null, chunk);
        },
      });
      const trackOut = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          this.touchActivity('wsDataFromClient');
          cb(null, chunk);
        },
      });
      proxySocket.pipe(trackIn).pipe(socket);
      socket.pipe(trackOut).pipe(proxySocket);
      proxySocket.write(proxyHead);
    });

    wsReq.on('response', (proxyRes) => {
      // The relay target refused the upgrade (e.g. a bad token on the
      // secondary's channel): forward the real HTTP answer instead of
      // limbo, then let the stream close.
      socket.write(
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
          Object.entries(proxyRes.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join('\r\n') +
          '\r\n\r\n',
      );
      proxyRes.pipe(socket);
    });

    wsReq.on('error', (err) => {
      this.logger.error('[InferDebug] WS proxy error:', err.message);
      socket.destroy();
    });

    request.pipe(wsReq);
  }

  private proxyHttp(
    req: TRequestLike,
    res: TResponseLike,
    hostname: string,
    port: number,
    headers?: http.OutgoingHttpHeaders,
    url?: string,
    responseHeaders?: Record<string, string>,
  ): void {
    const proxyHeaders = headers ? { ...headers } : { ...req.headers };

    if (req.body !== undefined) {
      delete proxyHeaders['content-length'];
    }

    const proxyReq = http.request(
      {
        hostname,
        port,
        path: url ?? req.url,
        method: req.method,
        headers: proxyHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode || 200, { ...proxyRes.headers, ...responseHeaders });
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', (err) => {
      this.logger.error('[InferDebug] Proxy error:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end('Bad Gateway');
      }
    });

    if (req.body !== undefined) {
      let body: string | Buffer;
      if (Buffer.isBuffer(req.body)) {
        body = req.body;
      } else if (typeof req.body === 'string') {
        body = req.body;
      } else {
        body = JSON.stringify(req.body);
      }
      proxyReq.setHeader('Content-Length', Buffer.byteLength(body));
      proxyReq.write(body);
      proxyReq.end();
    } else {
      req.pipe(proxyReq);
    }
  }

  private buildJumpUrl(req: TRequestLike): string | null {
    if (this.inspectorTargetId === null) {
      return null;
    }
    const host = req.headers.host;
    if (!host) {
      return null;
    }
    const result = buildDevtoolsJumpUrl(host, this.inspectorTargetId);
    return result;
  }

  /**
   * Learns the child's inspector target id from its /json/list. Never throws:
   * the jump header is best-effort — a miss only means no header this time.
   */
  private async fetchInspectorTargetId(): Promise<void> {
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          { hostname: '127.0.0.1', port: this.options.inspectorPort, path: '/json/list', timeout: 5000 },
          (res) => {
            let data = '';
            res.on('data', (chunk) => (data += chunk));
            res.on('end', () => resolve(data));
          },
        );
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('timeout'));
        });
      });
      const list = JSON.parse(body) as Array<{ id?: unknown }>;
      const target = Array.isArray(list) ? list.find((entry) => entry && typeof entry.id === 'string') : undefined;
      if (target && typeof target.id === 'string') {
        this.inspectorTargetId = target.id;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[InferDebug] Inspector target discovery failed (jump header disabled for now): ${message}`);
    }
  }

  private async waitForChildHealth(): Promise<void> {
    const maxRetries = 12;
    const interval = 10000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await this.checkChildHealth();
        this.isChildReady = true;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, interval));
      }
    }

    throw new Error('[InferDebug] Child did not become ready within timeout');
  }

  private waitForChildStdout(stdout: import('stream').Readable | null, pattern: RegExp): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!stdout) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for child stdout'));
      }, 120000);

      const onData = (data: Buffer): void => {
        const text = data.toString();
        if (pattern.test(text)) {
          cleanup();
          resolve();
        }
      };

      const cleanup = (): void => {
        clearTimeout(timeout);
        stdout.off('data', onData);
      };

      stdout.on('data', onData);
    });
  }

  private createLogBufferTransform(): Transform {
    let buffer = '';
    const logBuffer = this.logBuffer;
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          logBuffer.push(line);
        }
        this.touchActivity('childLog');
        callback(null, chunk);
      },
      flush(callback) {
        if (buffer.length) {
          logBuffer.push(buffer);
        }
        callback();
      },
    });
  }

  private createPrefixTransform(prefix: string): Transform {
    let buffer = '';
    return new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          this.push(`${prefix} ${line}\n`);
        }
        callback();
      },
      flush(callback) {
        if (buffer.length) {
          this.push(`${prefix} ${buffer}\n`);
        }
        callback();
      },
    });
  }

  private checkChildHealth(): Promise<void> {
    if (this.childPort === null) {
      return Promise.reject(new Error('child port unknown'));
    }
    if (!this.options.healthcheckPath) {
      return this.checkChildTcp(this.childPort);
    }
    return this.checkChildHttp(this.childPort, this.options.healthcheckPath);
  }

  private checkChildTcp(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port }, () => {
        socket.end();
        resolve();
      });
      socket.setTimeout(5000, () => {
        socket.destroy();
        reject(new Error('timeout'));
      });
      socket.on('error', reject);
    });
  }

  private checkChildHttp(port: number, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path,
          timeout: 5000,
        },
        (res) => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 500) {
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
  }

  private async autoStopWithZombieCheck(): Promise<void> {
    const pid = this.child?.pid;
    this.stopChild();
    await new Promise((r) => setTimeout(r, 10000));
    if (pid && this.isProcessAlive(pid)) {
      this.logger.error(`[InferDebug] Zombie present: child process ${pid} still alive after stop`);
    } else {
      this.logger.log('[InferDebug] No zombie made: child process terminated cleanly');
    }
    this.status = 'stopped';
  }
}
