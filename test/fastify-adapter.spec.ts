import Fastify from 'fastify';
import { inferDebugFastifyPlugin } from '../src/adapters/fastify';

describe('fastify adapter: inferDebugFastifyPlugin', () => {
  it('answers the control API, passes normal traffic through, decorates the instance', async () => {
    const app = Fastify();
    // Routes first, boot once via ready() — awaiting register() before adding
    // routes boots the app early and the routes never land.
    void app.register(inferDebugFastifyPlugin, { enabled: true, childPort: 3001 });
    app.get('/hello', async () => ({ ok: true }));
    await app.ready();

    const control = await app.inject({ method: 'GET', url: '/infer-debug/available' });
    expect(control.statusCode).toBe(200);
    expect(control.json()).toEqual({ status: 'ok' });

    const normal = await app.inject({ method: 'GET', url: '/hello' });
    expect(normal.statusCode).toBe(200);
    expect(normal.json()).toEqual({ ok: true });

    expect(app.inferDebug).toBeDefined();
    expect(app.inferDebug.getChildStatus()).toBe('stopped');

    await app.close();
  });

  it('is inert when disabled', async () => {
    const app = Fastify();
    void app.register(inferDebugFastifyPlugin, { enabled: false });
    app.get('/infer-debug/status', async () => ({ mine: true }));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/infer-debug/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mine: true });

    await app.close();
  });
});
