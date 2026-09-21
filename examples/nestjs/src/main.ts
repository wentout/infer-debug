import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Minimal NestJS host app: one business route plus a healthcheck.
 * Both report process.pid so you can tell WHICH process served a request
 * (main app vs debug child).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const port = Number(process.env.APP_PORT ?? 3003);
  await app.listen(port);
  console.log(`listening on :${port} (pid ${process.pid})`);
}

void bootstrap();
