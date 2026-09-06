import type { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { InferDebugCore } from '../../core/infer-debug-core';
import { TInferDebugOptions } from '../../infer-debug.options';

declare module 'fastify' {
  interface FastifyInstance {
    /** The plugin's core instance: start/stop/status/logs programmatically. */
    inferDebug: InferDebugCore;
  }
}

/**
 * Fastify adapter over the framework-free core:
 *
 *   await fastify.register(inferDebugFastifyPlugin, { childPortEnvVar: 'PORT' });
 *   // control API + header-marked proxying active; WS tunnel + port discovery
 *   // attach at fastify.ready(), child stops at fastify.close().
 *
 * The onRequest hook uses reply.hijack() only for requests the core will
 * definitively answer (shouldHandle), so your routes and hooks are untouched
 * by everything else.
 */
const plugin: FastifyPluginCallback<TInferDebugOptions> = (fastify: FastifyInstance, options: TInferDebugOptions, done: (err?: Error) => void): void => {
  const core = new InferDebugCore(options);
  fastify.decorate('inferDebug', core);

  fastify.addHook('onRequest', (request, reply, hookDone) => {
    const matched = core.shouldHandle(request.raw);
    if (!matched) {
      hookDone();
      return;
    }
    reply.hijack();
    core.handleHttp(request.raw, reply.raw);
  });

  // onReady (not fastify.ready()!): calling ready() inside a plugin boots the
  // instance early and every later route registration throws "already listening".
  fastify.addHook('onReady', (readyDone) => {
    core.attachServer(fastify.server);
    readyDone();
  });

  fastify.addHook('onClose', (_instance, closeDone) => {
    core.close();
    closeDone();
  });

  done();
};

// fastify-plugin's essence, inlined to avoid the dependency: without this
// marker, register() encapsulates the plugin — the onRequest hook and the
// decoration would apply only to routes declared inside the plugin, and our
// control API (unmatched app paths) would fall to the 404 handler untouched.
// Fastify v3–v5 all honor Symbol.for('skip-override').
(plugin as unknown as Record<symbol, boolean>)[Symbol.for('skip-override')] = true;

export const inferDebugFastifyPlugin: FastifyPluginCallback<TInferDebugOptions> = plugin;
export { InferDebugCore };
