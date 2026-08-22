import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Process-level fault handlers: log with the FULL STACK and keep running.
// With Node started via --enable-source-maps and the build using
// inlineSourceMap+inlineSources, these stacks reference the .ts sources.
process.on('uncaughtException', (err: Error) => {
  console.error(`[fixture] uncaughtException captured:\n${err.stack}`);
});

process.on('unhandledRejection', (reason: unknown) => {
  const stack = reason instanceof Error ? reason.stack : String(reason);
  console.error(`[fixture] unhandledRejection captured:\n${stack}`);
});

/**
 * Minimal host app for the e2e: one business route plus a healthcheck.
 * Both report process.pid so a test can tell WHICH process served a request
 * (main app vs debug child).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  const port = Number(process.env.APP_PORT ?? 4123);
  await app.listen(port);
  console.log(`Server listening on port ${port}`);
}

void bootstrap();
