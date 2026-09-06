import { InferDebugMiddleware } from '../src/infer-debug.middleware';

// The middleware delegates the routing decision to the service's
// isMarkedForDebug — these tests pin the delegation; the header logic itself
// lives in infer-debug.service.spec.ts.

function makeService() {
  return {
    getBasePath: () => '/infer-debug',
    isMarkedForDebug: jest.fn(),
    proxyToChild: jest.fn(),
  };
}

function makeReq(originalUrl: string, headers: Record<string, string> = {}) {
  return { originalUrl, url: originalUrl, headers } as never;
}

describe('InferDebugMiddleware', () => {
  it('passes control endpoints and inspector discovery through', () => {
    const service = makeService();
    const middleware = new InferDebugMiddleware(service as never);
    const next = jest.fn();

    for (const url of ['/infer-debug', '/infer-debug/status', '/json/list', '/json/version']) {
      middleware.use(makeReq(url), {} as never, next);
    }

    expect(next).toHaveBeenCalledTimes(4);
    expect(service.proxyToChild).not.toHaveBeenCalled();
  });

  it('proxies requests the service marks for debug', () => {
    const service = makeService();
    service.isMarkedForDebug.mockReturnValue(true);
    const middleware = new InferDebugMiddleware(service as never);
    const next = jest.fn();
    const req = makeReq('/api/orders/1', { 'infer-debug': '1' });

    middleware.use(req, {} as never, next);

    expect(service.proxyToChild).toHaveBeenCalledWith(req, expect.anything(), '/api/orders/1');
    expect(next).not.toHaveBeenCalled();
  });

  it('lets unmarked requests fall through to the app', () => {
    const service = makeService();
    service.isMarkedForDebug.mockReturnValue(false);
    const middleware = new InferDebugMiddleware(service as never);
    const next = jest.fn();

    middleware.use(makeReq('/api/orders/1'), {} as never, next);

    expect(next).toHaveBeenCalled();
    expect(service.proxyToChild).not.toHaveBeenCalled();
  });
});
