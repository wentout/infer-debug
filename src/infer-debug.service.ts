import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { InferDebugCore } from './core/infer-debug-core';
import { TInferDebugOptions } from './infer-debug.options';
import { INFER_DEBUG_OPTIONS } from './tokens';

export { TInferDebugStatus, TZombieInfo } from './core/infer-debug-core';

/**
 * NestJS shell around {@link InferDebugCore}: DI wiring plus the two lifecycle
 * hooks. All behavior lives in the framework-free core (src/core/).
 */
@Injectable()
export class InferDebugService extends InferDebugCore implements OnApplicationBootstrap, OnModuleDestroy {
  constructor(
    @Inject(INFER_DEBUG_OPTIONS) options: TInferDebugOptions,
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {
    super(options, new Logger(InferDebugService.name));
  }

  onApplicationBootstrap(): void {
    const httpServer = this.httpAdapterHost.httpAdapter.getHttpServer();
    this.attachServer(httpServer);
  }

  onModuleDestroy(): void {
    this.close();
  }
}
