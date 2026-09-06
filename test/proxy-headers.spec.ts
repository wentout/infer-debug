import { PassThrough } from 'stream';
import { EventEmitter } from 'events';

jest.mock('child_process', () => ({ spawn: jest.fn() }));

const mockRequest = jest.fn();
const mockGet = jest.fn();
jest.mock('http', () => ({
  ...jest.requireActual('http'),
  request: (...args: unknown[]) => mockRequest(...args),
  get: (...args: unknown[]) => mockGet(...args),
}));

import { InferDebugService } from '../src/infer-debug.service';

function makeAdapterHost() {
  const httpServer = new EventEmitter();
  return { httpAdapter: { getHttpServer: () => httpServer } } as never;
}

function makeReqRes(url: string, headers: Record<string, string>) {
  const req = new PassThrough() as any;
  req.method = 'GET';
  req.url = url;
  req.headers = headers;
  const res = new PassThrough() as any;
  res.writeHead = jest.fn();
  res.end = jest.fn();
  return { req, res };
}

function fakeChildAnswering(status: number, headers: Record<string, string>) {
  mockRequest.mockImplementation((options, cb) => {
    const proxyReq = new PassThrough() as any;
    proxyReq.setHeader = jest.fn();
    process.nextTick(() => {
      const proxyRes = new PassThrough() as any;
      proxyRes.statusCode = status;
      proxyRes.headers = headers;
      cb(proxyRes);
      proxyRes.end('{}');
    });
    return proxyReq;
  });
}

describe('proxyToChild header handling', () => {
  beforeEach(() => {
    mockRequest.mockReset();
    mockGet.mockReset();
  });

  it('consumes the trigger header and answers with the DevTools jump link', async () => {
    const service = new InferDebugService({ enabled: true, childPort: 3001 }, makeAdapterHost());
    service.onApplicationBootstrap();
    (service as any).isChildReady = true;
    (service as any).inspectorTargetId = 'target-uuid';

    let capturedOptions: any;
    mockRequest.mockImplementation((options, cb) => {
      capturedOptions = options;
      const proxyReq = new PassThrough() as any;
      proxyReq.setHeader = jest.fn();
      process.nextTick(() => {
        const proxyRes = new PassThrough() as any;
        proxyRes.statusCode = 200;
        proxyRes.headers = { 'content-type': 'application/json' };
        cb(proxyRes);
        proxyRes.end('{}');
      });
      return proxyReq;
    });

    const { req, res } = makeReqRes('/api/orders/1', {
      host: 'api.example.com',
      authorization: 'Bearer x',
      'infer-debug': '1',
    });

    service.proxyToChild(req, res, '/api/orders/1');
    req.end();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The trigger header is consumed by the proxy, not forwarded — the child
    // runs the same module and would try to proxy to a nonexistent grandchild.
    expect(capturedOptions.headers['infer-debug']).toBeUndefined();
    expect(capturedOptions.headers.authorization).toBe('Bearer x');

    // The response carries the jump link keyed to the REQUEST's host, so it
    // attaches through the app's own port.
    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({
        'infer-debug': 'devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=api.example.com/target-uuid',
      }),
    );
  });

  it('omits the jump header (and retries discovery) when the target id is unknown', async () => {
    const service = new InferDebugService({ enabled: true, childPort: 3001 }, makeAdapterHost());
    service.onApplicationBootstrap();
    (service as any).isChildReady = true;
    const fetchSpy = jest.spyOn(service as any, 'fetchInspectorTargetId').mockResolvedValue(undefined);

    fakeChildAnswering(200, {});

    const { req, res } = makeReqRes('/x', { host: 'h', 'infer-debug': '1' });

    service.proxyToChild(req, res, '/x');
    req.end();
    await new Promise((r) => setImmediate(r));

    const [, headers] = res.writeHead.mock.calls[0];
    expect(headers['infer-debug']).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });
});
