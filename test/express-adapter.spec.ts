import { InferDebugCore } from '../src/core/infer-debug-core';
import { createInferDebugMiddleware } from '../src/adapters/express';

describe('express adapter: createInferDebugMiddleware', () => {
  it('passes unmarked traffic to next()', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const middleware = createInferDebugMiddleware(core);

    const req = { method: 'GET', url: '/api/orders/1', headers: {} } as any;
    const res = { writeHead: jest.fn(), end: jest.fn() } as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('answers control requests without calling next()', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const middleware = createInferDebugMiddleware(core);

    const req = { method: 'GET', url: '/infer-debug/available', headers: {} } as any;
    const res = { writeHead: jest.fn(), end: jest.fn() } as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ status: 'ok' }));
  });

  it('proxies header-marked requests (503 while the child is down)', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    const middleware = createInferDebugMiddleware(core);

    const req = { method: 'GET', url: '/api/orders/1', headers: { 'infer-debug': '1' } } as any;
    const res = { writeHead: jest.fn(), end: jest.fn() } as any;
    const next = jest.fn();

    middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(503);
  });
});
