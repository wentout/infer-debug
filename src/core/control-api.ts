import type { InferDebugCore } from './infer-debug-core';
import { TRequestLike, TResponseLike } from './http-like';

/**
 * The control API as plain req/res routing — the implementation used by
 * `InferDebugCore.handleHttp`, i.e. by every non-NestJS adapter (Express,
 * Fastify, raw Node).
 *
 * The NestJS adapter keeps its own decorated controller
 * (src/infer-debug.controller.ts) for Swagger visibility; it calls the same
 * InferDebugCore methods, so endpoint semantics cannot diverge — only the
 * response formatting is duplicated. If you change one, mirror the other.
 */

const sendText = (res: TResponseLike, status: number, text: string): void => {
  res.writeHead(status, { 'Content-Type': 'text/plain' });
  res.end(text);
};

const sendJson = (res: TResponseLike, value: unknown): void => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

/** Exact method+path pairs the control API answers (bare basePath is NOT one). */
export function matchControlRoute(basePath: string, method: string | undefined, path: string): boolean {
  switch (method) {
    case 'GET':
      return path === `${basePath}/available` || path === `${basePath}/status` || path === `${basePath}/logs`;
    case 'POST':
      return path === `${basePath}/start` || path === `${basePath}/stop`;
    case 'DELETE':
      return path === `${basePath}/logs`;
    default:
      return false;
  }
}

/** Assumes `matchControlRoute` was true — routes to the matching core call. */
export function handleControlRequest(core: InferDebugCore, req: TRequestLike, res: TResponseLike): void {
  const basePath = core.getBasePath();
  const fullUrl = req.originalUrl || req.url || '';
  const [path, query] = fullUrl.split('?');
  const method = req.method;

  if (method === 'GET' && path === `${basePath}/available`) {
    const result = core.getDebugAbility();
    sendJson(res, result);
    return;
  }

  if (method === 'GET' && path === `${basePath}/status`) {
    core.touchActivity('controller/status');
    const status = core.getChildStatus();
    const zombie = core.hasZombie();
    const debuggerActive = core.hasActiveDebugger();
    const text = `${status}: ${zombie}: debugger ${debuggerActive ? 'attached' : 'detached'}`;
    sendText(res, 200, text);
    return;
  }

  if (method === 'POST' && path === `${basePath}/start`) {
    core.touchActivity('controller/start');
    const before = core.getChildStatus();
    void core.startChild();
    const after = core.getChildStatus();
    const text = before === after && (before === 'starting' || before === 'running') ? `already ${after}` : after;
    sendText(res, 200, text);
    return;
  }

  if (method === 'POST' && path === `${basePath}/stop`) {
    core.touchActivity('controller/stop');
    core.stopChild();
    const status = core.getChildStatus();
    sendText(res, 200, status);
    return;
  }

  if (method === 'GET' && path === `${basePath}/logs`) {
    core.touchActivity('controller/getLogs');
    const params = new URLSearchParams(query ?? '');
    const linesParam = params.get('lines');
    const count = linesParam ? parseInt(linesParam, 10) : 100;
    const logs = core.getLogs(count);
    sendText(res, 200, logs.join('\n'));
    return;
  }

  // DELETE <basePath>/logs — the only remaining matched route.
  core.touchActivity('controller/clearLogs');
  core.clearLogs();
  sendText(res, 200, '');
}
