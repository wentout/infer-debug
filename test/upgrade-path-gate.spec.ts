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
