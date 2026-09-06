import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { InferDebugCore } from '../../core/infer-debug-core';

/**
 * Express/connect adapter: a middleware factory over the framework-free core.
 *
 * The middleware handles the control API, inspector discovery, and
 * header-marked requests; everything else falls through to your routes.
 * The WS inspector tunnel and child-port discovery need the raw server:
 *
 *   const core = new InferDebugCore({ childPortEnvVar: 'PORT' });
 *   app.use(createInferDebugMiddleware(core));
 *   const server = app.listen(3000, () => core.attachServer(server));
 *   // on shutdown: core.close();
 *
 * Plain `app.use` mounts do NOT strip `req.url` (that stripping is a NestJS
 * `forRoutes('*')` artifact), and the core reads `originalUrl ?? url` anyway.
 * If a body parser ran before this middleware, the proxied request is rebuilt
 * from `req.body` with a recalculated Content-Length.
 */
export function createInferDebugMiddleware(core: InferDebugCore): RequestHandler {
  const middleware: RequestHandler = (req: Request, res: Response, next: NextFunction): void => {
    const handled = core.handleHttp(req, res);
    if (!handled) {
      next();
    }
  };
  return middleware;
}
