import { Module } from '@nestjs/common';
// The built package, exactly as an external consumer would import it.
import { InferDebugModule } from '../../dist';
import { FaultsController } from './faults.controller';
import { OrdersController } from './orders.controller';

@Module({
  imports: [
    InferDebugModule.forRoot({
      healthcheckPath: '/healthcheck',
      childReadyStdoutPattern: /Server listening on port/i,
      // Fixed inspector port so the e2e and docker setup are deterministic.
      inspectorPort: 9339,
    }),
  ],
  controllers: [OrdersController, FaultsController],
})
export class AppModule {}
