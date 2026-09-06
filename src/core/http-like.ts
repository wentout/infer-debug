import * as http from 'http';

/**
 * Minimal structural view of an incoming request — satisfied by Express's
 * Request, Fastify's `request.raw`, and plain `http.IncomingMessage`.
 *
 * `originalUrl` and `body` are host-framework HINTS, not requirements:
 * Express sets `originalUrl` (Nest's `forRoutes('*')` wildcard mount strips
 * `req.url` to '/', so the real path survives only there), and `body` exists
 * when a body parser ran before us. Both are absent on raw Node.
 */
export type TRequestLike = http.IncomingMessage & {
  originalUrl?: string;
  body?: unknown;
};

/** Anything the proxy writes to must be a raw Node response. */
export type TResponseLike = http.ServerResponse;

/**
 * Logging contract of the core. The NestJS adapter passes its `Logger`;
 * everyone else gets the console default below.
 */
export type TInferDebugLogger = {
  log(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
};

/** Default core logger. Messages carry their own `[InferDebug]` prefix. */
export const consoleInferDebugLogger: TInferDebugLogger = {
  log: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message, ...rest) => console.error(message, ...rest),
};
