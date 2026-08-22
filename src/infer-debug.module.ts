import { DynamicModule, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { createInferDebugController } from './infer-debug.controller';
import { InferDebugMiddleware } from './infer-debug.middleware';
import { InferDebugService } from './infer-debug.service';
import { normalizeBasePath, TInferDebugOptions } from './infer-debug.options';
import { INFER_DEBUG_OPTIONS } from './tokens';

export type TInferDebugAsyncOptions = {
  /**
   * Base path of the control API. Static even in forRootAsync, because route
   * decorators must be known when the module is declared (before DI runs).
   * Default: '/infer-debug'.
   */
  basePath?: string;
  imports?: DynamicModule['imports'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => TInferDebugOptions | Promise<TInferDebugOptions>;
};

@Module({})
export class InferDebugModule implements NestModule {
  static forRoot(options: TInferDebugOptions = {}): DynamicModule {
    return {
      module: InferDebugModule,
      controllers: [createInferDebugController(normalizeBasePath(options.basePath))],
      providers: [{ provide: INFER_DEBUG_OPTIONS, useValue: options }, InferDebugService],
      exports: [InferDebugService],
    };
  }

  static forRootAsync(asyncOptions: TInferDebugAsyncOptions): DynamicModule {
    return {
      module: InferDebugModule,
      imports: asyncOptions.imports ?? [],
      controllers: [createInferDebugController(normalizeBasePath(asyncOptions.basePath))],
      providers: [
        {
          provide: INFER_DEBUG_OPTIONS,
          useFactory: asyncOptions.useFactory,
          inject: asyncOptions.inject ?? [],
        },
        InferDebugService,
      ],
      exports: [InferDebugService],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    // Runs before NestJS routing: matched debug traffic is proxied to the child
    // process, everything else falls through to the host app's controllers.
    consumer.apply(InferDebugMiddleware).forRoutes('*');
  }
}
