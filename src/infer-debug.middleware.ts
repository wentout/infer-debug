import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { InferDebugService } from './infer-debug.service';

@Injectable()
export class InferDebugMiddleware implements NestMiddleware {
  constructor(private readonly debugProxyService: InferDebugService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // IMPORTANT: this middleware is mounted via forRoutes('*'), which Express 5
    // turns into a wildcard mount that strips req.url down to '/' in here.
    // originalUrl always keeps the full path (+ query string, hence the split).
    const url = (req.originalUrl || req.url).split('?')[0];

    // Control endpoints and inspector discovery are served by the controller.
    const basePath = this.debugProxyService.getBasePath();
    if (url === basePath || url.startsWith(`${basePath}/`) || url === '/json/version' || url === '/json/list') {
      return next();
    }

    if (this.debugProxyService.shouldProxy(url)) {
      return this.debugProxyService.proxyToChild(req, res, url);
    }

    next();
  }
}
