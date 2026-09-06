import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

/**
 * Example: route-table-driven debug marking.
 *
 * infer-debug itself is route-agnostic: any request carrying the trigger
 * header (default 'infer-debug') is proxied to the debug child. Choosing
 * WHICH routes deserve that is the app's own concern — this middleware is the
 * pattern: match the path against your own table, set the header, and let
 * InferDebugMiddleware (which runs after this one) do the proxying.
 *
 * Registration order matters: apply it in the ROOT module's configure() —
 * NestJS runs the root module's middleware before imported modules':
 *
 *   export class AppModule implements NestModule {
 *     configure(consumer: MiddlewareConsumer): void {
 *       consumer.apply(RouteDebugMiddleware).forRoutes('*');
 *     }
 *   }
 *
 * Change DEBUG_HEADER if you overrode the module's `headerName` option.
 */
const DEBUG_HEADER = 'infer-debug';

// Your table, your rules — swagger-style templates:
//   '/api/orders/{id}'  matches one segment
//   '/api/orders/{*}'   matches the whole subtree
const DEBUG_ROUTES = ['/api/orders/{id}', '/api/faults/{*}'];

/**
 * Matches a swagger-style route template against an actual request path.
 * (This helper used to live in the package; route selection moved out with
 * the registry, so the example carries it.)
 */
function matchRouteTemplate(template: string, actual: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withSubtreeWildcard = escaped.replace(/\/\\\{\\\*\\\}/g, '(?:/.*)?');
  const parameterized = withSubtreeWildcard.replace(/\\\{[^}]+\\\}/g, '[^/]+');
  const regex = new RegExp('^' + parameterized + '$');
  return regex.test(actual);
}

@Injectable()
export class RouteDebugMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const url = (req.originalUrl || req.url).split('?')[0];
    if (DEBUG_ROUTES.some((template) => matchRouteTemplate(template, url))) {
      req.headers[DEBUG_HEADER] = '1';
    }
    next();
  }
}
