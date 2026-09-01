import { EventEmitter } from 'events';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
import { InferDebugService } from '../src/infer-debug.service';

const spawnMock = spawn as jest.Mock;

function makeAdapterHost() {
  const httpServer = new EventEmitter();
  return { httpAdapter: { getHttpServer: () => httpServer } } as never;
}

function makeService(): InferDebugService {
  return new InferDebugService({ enabled: true, childPort: 3001 }, makeAdapterHost());
}

function makeFakeChild() {
  const child = new EventEmitter() as any;
  child.stdout = null;
  child.stderr = null;
  child.pid = 424242;
  child.kill = jest.fn();
  return child;
}

describe('InferDebugService.startChild', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('goes running once the child becomes healthy', async () => {
    const service = makeService();
    service.onApplicationBootstrap();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    jest.spyOn(service as any, 'waitForChildHealth').mockResolvedValue(undefined);

    await service.startChild();

    expect(spawnMock).toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect((service as any).status).toBe('running');
  });

  it('kills the child and settles back to stopped when the child never becomes ready', async () => {
    const service = makeService();
    service.onApplicationBootstrap();
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    jest.spyOn(service as any, 'waitForChildHealth').mockRejectedValue(new Error('never ready'));

    await service.startChild();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect((service as any).status).toBe('stopped');
    expect((service as any).child).toBeNull();
  });

  it('refuses to start while a zombie child is present', async () => {
    const service = makeService();
    service.onApplicationBootstrap();
    jest.spyOn(service as any, 'hasZombie').mockReturnValue('has zombie');

    await service.startChild();

    expect(spawnMock).not.toHaveBeenCalled();
    expect((service as any).status).toBe('stopped');
  });
});
