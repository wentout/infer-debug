import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mockRequest = jest.fn();
jest.mock('http', () => ({
  ...jest.requireActual('http'),
  request: (...args: unknown[]) => mockRequest(...args),
}));

import { InferDebugCore, isInspectorUpgradePath } from '../src/core/infer-debug-core';

describe('isInspectorUpgradePath', () => {
  it('accepts only /<target-uuid> paths', () => {
    expect(isInspectorUpgradePath('/be5bd542-29b4-4ff9-94d9-f306d316b1d9')).toBe(true);
    expect(isInspectorUpgradePath('/be5bd542-29b4-4ff9-94d9-f306d316b1d9?x=1')).toBe(true);
    expect(isInspectorUpgradePath('/socket.io/')).toBe(false);
    expect(isInspectorUpgradePath('/json/list')).toBe(false);
    expect(isInspectorUpgradePath('/ws')).toBe(false);
    expect(isInspectorUpgradePath(undefined)).toBe(false);
  });
});

describe('handleUpgrade path gate', () => {
  const UUID_URL = '/be5bd542-29b4-4ff9-94d9-f306d316b1d9';

  beforeEach(() => {
    mockRequest.mockReset();
  });

  function makeSocket() {
    const socket = new PassThrough() as any;
    return Object.assign(socket, { destroy: jest.fn() });
  }

  it('leaves foreign upgrade paths alone even when the child is ready', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    (core as any as { isChildReady: boolean }).isChildReady = true;

    const request = new PassThrough() as any;
    (request as { url?: string }).url = '/socket.io/?transport=websocket';
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('leaves inspector paths alone when the child is not ready', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });

    const request = new PassThrough() as any;
    (request as { url?: string }).url = UUID_URL;
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('tunnels uuid-shaped upgrades to the inspector when the child is ready', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    (core as any as { isChildReady: boolean }).isChildReady = true;
    mockRequest.mockReturnValue(new EventEmitter());

    const request = new PassThrough() as any;
    (request as { url?: string }).url = UUID_URL;
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9229, path: UUID_URL }),
    );
  });
});

describe('handleUpgrade marked-upgrade relay (rule 2)', () => {
  beforeEach(() => {
    mockRequest.mockReset();
  });

  function makeSocket() {
    const socket = new PassThrough() as any;
    return Object.assign(socket, { destroy: jest.fn(), write: jest.fn() });
  }

  function makeMarkedRequest(url: string) {
    const request = new PassThrough() as any;
    (request as { url?: string }).url = url;
    (request as { headers?: Record<string, string> }).headers = { 'infer-debug': '1' };
    return request;
  }

  it('relays a marked non-inspector upgrade to the child port, header consumed', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    (core as any as { isChildReady: boolean; childPort: number | null }).isChildReady = true;
    (core as any as { isChildReady: boolean; childPort: number | null }).childPort = 3001;
    mockRequest.mockReturnValue(new EventEmitter());

    const request = makeMarkedRequest('/strategy?token=abc');
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        port: 3001,
        path: '/strategy?token=abc',
        headers: expect.not.objectContaining({ 'infer-debug': expect.anything() }),
      }),
    );
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('forwards a non-101 answer from the secondary instead of limbo', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    (core as any as { isChildReady: boolean; childPort: number | null }).isChildReady = true;
    (core as any as { isChildReady: boolean; childPort: number | null }).childPort = 3001;
    const wsReq = new EventEmitter();
    mockRequest.mockReturnValue(wsReq);

    const request = makeMarkedRequest('/strategy?token=wrong');
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    const proxyRes = Object.assign(new EventEmitter(), {
      httpVersion: '1.1',
      statusCode: 401,
      statusMessage: 'Unauthorized',
      headers: { 'content-length': '0' },
      pipe: jest.fn(),
    });
    wsReq.emit('response', proxyRes);

    expect(String(socket.write.mock.calls[0][0])).toContain('401');
    expect(proxyRes.pipe).toHaveBeenCalledWith(socket);
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('answers 503 when the secondary is not running', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });

    const request = makeMarkedRequest('/strategy?token=abc');
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(String(socket.write.mock.calls[0][0])).toContain('503');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('leaves unmarked upgrades alone even when the child is ready', () => {
    const core = new InferDebugCore({ enabled: true, childPort: 3001 });
    (core as any as { isChildReady: boolean; childPort: number | null }).isChildReady = true;
    (core as any as { isChildReady: boolean; childPort: number | null }).childPort = 3001;

    const request = new PassThrough() as any;
    (request as { url?: string }).url = '/strategy?token=abc';
    (request as { headers?: Record<string, string> }).headers = {};
    const socket = makeSocket();

    core.handleUpgrade(request as EventEmitter as any, socket, Buffer.alloc(0));

    expect(mockRequest).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
    expect(socket.write).not.toHaveBeenCalled();
  });
});
