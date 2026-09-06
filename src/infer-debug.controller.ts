import { Controller, Delete, Get, Post, Res, Req, Query, Type } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { InferDebugService } from './infer-debug.service';

/**
 * Builds the control-endpoint controller with routes under the given base path.
 * A factory (not a static class) because NestJS route decorators are static —
 * the base path has to be known when the class is declared.
 *
 * Endpoints (`${basePath}` defaults to `/infer-debug`):
 *   GET    `${basePath}/available` — can a debug session start? ({status, reason?})
 *   GET    `${basePath}/status`    — child status + zombie + debugger state
 *   POST   `${basePath}/start`     — spawn the debug child
 *   POST   `${basePath}/stop`      — stop the debug child
 *   GET    `${basePath}/logs`      — child log buffer (?lines=N)
 *   DELETE `${basePath}/logs`      — clear log buffer
 *   GET    `/json/list`, `/json/version` — Chrome DevTools inspector discovery
 */
export function createInferDebugController(basePath: string): Type<unknown> {
  @Controller()
  class InferDebugController {
    constructor(private readonly debugProxyService: InferDebugService) {}

    @Get(`${basePath}/available`)
    getDebugAbility(@Res() res: Response): void {
      const result = this.debugProxyService.getDebugAbility();
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(result));
    }

    @Get(`${basePath}/status`)
    getStatus(@Res() res: Response): void {
      this.debugProxyService.touchActivity('controller/status');
      const status = this.debugProxyService.getChildStatus();
      const zombie = this.debugProxyService.hasZombie();
      const debuggerActive = this.debugProxyService.hasActiveDebugger();
      const text = `${status}: ${zombie}: debugger ${debuggerActive ? 'attached' : 'detached'}`;
      res.setHeader('Content-Type', 'text/plain');
      res.send(text);
    }

    @Post(`${basePath}/start`)
    start(@Res() res: Response): void {
      this.debugProxyService.touchActivity('controller/start');
      const before = this.debugProxyService.getChildStatus();
      void this.debugProxyService.startChild();
      const after = this.debugProxyService.getChildStatus();
      const text = before === after && (before === 'starting' || before === 'running') ? `already ${after}` : after;
      res.setHeader('Content-Type', 'text/plain');
      res.send(text);
    }

    @Post(`${basePath}/stop`)
    stop(@Res() res: Response): void {
      this.debugProxyService.touchActivity('controller/stop');
      this.debugProxyService.stopChild();
      res.setHeader('Content-Type', 'text/plain');
      res.send(this.debugProxyService.getChildStatus());
    }

    @Get(`${basePath}/logs`)
    @ApiQuery({
      name: 'lines',
      required: false,
      description: 'Number of log lines to return (1 to logBufferSize). Defaults to 100.',
      schema: { type: 'string', default: '100' },
    })
    getLogs(@Query('lines') lines: string, @Res() res: Response): void {
      this.debugProxyService.touchActivity('controller/getLogs');
      const count = lines ? parseInt(lines, 10) : 100;
      const logs = this.debugProxyService.getLogs(count);
      res.setHeader('Content-Type', 'text/plain');
      res.send(logs.join('\n'));
    }

    @Delete(`${basePath}/logs`)
    clearLogs(@Res() res: Response): void {
      this.debugProxyService.touchActivity('controller/clearLogs');
      this.debugProxyService.clearLogs();
      res.setHeader('Content-Type', 'text/plain');
      res.send('');
    }

    @Get('/json/list')
    getJsonList(@Req() req: Request, @Res() res: Response): void {
      if (!this.debugProxyService.isReady()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      this.debugProxyService.proxyToInspector(req, res);
    }

    @Get('/json/version')
    getJsonVersion(@Req() req: Request, @Res() res: Response): void {
      if (!this.debugProxyService.isReady()) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      this.debugProxyService.proxyToInspector(req, res);
    }
  }

  return InferDebugController;
}
