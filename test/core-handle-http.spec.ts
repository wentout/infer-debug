import { InferDebugCore } from '../src/core/infer-debug-core';

/**
 * The core with zero framework imports: no NestJS DI, no Express app — plain
 * req/res in, boolean "handled" out. This suite is the proof.
 */

function makeReqRes(method: string, url: string, headers: Record<string, string> = {}) {
  const req = { method, url, headers } as any;
  const res = { writeHead: jest.fn(), end: jest.fn() } as any;
  return { req, res };
}

describe('InferDebugCore.shouldHandle / handleHttp', () => {
  it('is inert when disabled (default env gate)', () => {
    const core = new InferDebugCore({ enabled: false });
    const { req } = makeReqRes('GET', '/infer-debug/status', {});
    expect(core.shouldHandle(req)).toBe(false);
  });

  it('matches control routes, inspector discovery, and marked requests only', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });

    expect(core.shouldHandle(makeReqRes('GET', '/infer-debug/available').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('GET', '/infer-debug/status').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('POST', '/infer-debug/start').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('POST', '/infer-debug/stop').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('GET', '/infer-debug/logs').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('DELETE', '/infer-debug/logs').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('GET', '/json/list').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('GET', '/json/version').req)).toBe(true);
    expect(core.shouldHandle(makeReqRes('GET', '/api/orders/1', { 'infer-debug': '1' }).req)).toBe(true);

    // Unknown control subpaths and unmarked traffic are NOT ours.
    expect(core.shouldHandle(makeReqRes('POST', '/infer-debug/nope').req)).toBe(false);
    expect(core.shouldHandle(makeReqRes('GET', '/infer-debug').req)).toBe(false);
    expect(core.shouldHandle(makeReqRes('GET', '/api/orders/1').req)).toBe(false);
  });

  it('answers the control API without any framework', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const { req, res } = makeReqRes('GET', '/infer-debug/available');
    const handled = core.handleHttp(req, res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }));
  });

  it('gates inspector discovery on readiness (404 when the child is down)', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const { req, res } = makeReqRes('GET', '/json/list');
    const handled = core.handleHttp(req, res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(404);
  });

  it('503s a marked request when the child is down', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const { req, res } = makeReqRes('GET', '/api/orders/1', { 'infer-debug': '1' });
    const handled = core.handleHttp(req, res);
    expect(handled).toBe(true);
    expect(res.writeHead).toHaveBeenCalledWith(503);
  });

  it('returns false for unmarked traffic and leaves res untouched', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const { req, res } = makeReqRes('GET', '/api/orders/1');
    const handled = core.handleHttp(req, res);
    expect(handled).toBe(false);
    expect(res.writeHead).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });
});
