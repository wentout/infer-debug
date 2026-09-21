import { Module } from '@nestjs/common';
import { InferDebugModule } from 'infer-debug/nestjs';
import { OrdersController } from './orders.controller';

@Module({
  imports: [
    // Zero-config works too (forRoot() + INFER_DEBUG=true env); these two
    // options just make child readiness fast and deterministic.
    InferDebugModule.forRoot({
      healthcheckPath: '/healthcheck',
      childReadyStdoutPattern: /listening on :/i,
    }),
  ],
  controllers: [OrdersController],
})
export class AppModule {}
