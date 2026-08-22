import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { spawn, ChildProcess } from 'child_process';
import * as http from 'http';
import * as net from 'net';
import { Request, Response } from 'express';
import { Transform, Duplex } from 'stream';
import { CircularBuffer } from './models/circular-buffer';
import { matchRouteTemplate } from './models/route-matcher';
import {
  TInferDebugOptions,
  TResolvedInferDebugOptions,
  resolveInferDebugOptions,
} from './infer-debug.options';
import { INFER_DEBUG_OPTIONS } from './tokens';

export type TInferDebugStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type TZombieInfo = 'no zombie' | 'has zombie';

@Injectable()
export class InferDebugService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(InferDebugService.name);
  private child: ChildProcess | null = null;
  private childPort: number | null = null;
  private readonly baseRoutes: string[] = ['/json/list', '/json/version'];
  private routes: string[] = [];
  private isChildReady = false;
  private status: TInferDebugStatus = 'stopped';
  private readonly logBuffer: CircularBuffer<string>;
  private lastActivityAt = Date.now();
  private lastActivitySource = 'none';
  private readonly options: TResolvedInferDebugOptions;

  constructor(
    @Inject(INFER_DEBUG_OPTIONS) options: TInferDebugOptions,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    this.options = resolveInferDebugOptions(options);
    this.logBuffer = new CircularBuffer<string>(this.options.logBufferSize);
  }

  onModuleInit(): void {
    if (!this.options.enabled) {
      return;
    }
    setInterval(() => {
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
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      return;
    }
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();

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

  onModuleDestroy(): void {
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

    await stdoutReady;
    await this.waitForChildHealth();
    this.status = 'running';
    this.touchActivity('startChild');
    this.logger.log(`[InferDebug] Child ready on port ${this.childPort}, inspector on ${this.options.inspectorPort}`);
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

  getRoutes(): string[] {
    return [...this.routes, ...this.baseRoutes];
  }

  setRoutes(routes: string[]): void {
    const filtered = routes.filter((route) => !this.baseRoutes.includes(route));
    this.routes = [...new Set(filtered)];
  }

  shouldProxy(url: string): boolean {
    if (!this.isChildReady) {
      return false;
    }
    const allRoutes = [...this.routes, ...this.baseRoutes];
    return allRoutes.some((route) => matchRouteTemplate(route, url));
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

  proxyToChild(req: Request, res: Response, url?: string): void {
    if (!this.isChildReady || this.childPort === null) {
      res.writeHead(503);
      res.end('Debug proxy child not running');
      return;
    }
    this.touchActivity('proxyToChild');
    this.proxyHttp(req, res, '127.0.0.1', this.childPort, undefined, url);
  }

  proxyToInspector(req: Request, res: Response): void {
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
    if (!this.isChildReady) {
      // Not ours: leave the socket to other upgrade listeners instead of
      // destroying it — the host app may serve its own WebSockets.
      return;
    }
    this.touchActivity('handleUpgrade');
    const wsReq = http.request({
      hostname: '127.0.0.1',
      port: this.options.inspectorPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${this.options.inspectorPort}` },
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
          this.touchActivity('wsDataFromInspector');
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

    wsReq.on('error', (err) => {
      this.logger.error('[InferDebug] WS proxy error:', err.message);
      socket.destroy();
    });

    request.pipe(wsReq);
  }

  private proxyHttp(req: Request, res: Response, hostname: string, port: number, headers?: http.OutgoingHttpHeaders, url?: string): void {
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
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
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

    this.logger.error('[InferDebug] Child did not become ready within timeout');
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
