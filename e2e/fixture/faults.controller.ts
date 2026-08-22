import { Controller, Post } from '@nestjs/common';

/**
 * Routes that deliberately fault OUTSIDE the NestJS request context.
 * An exception thrown inside a controller method is caught by Nest's exception
 * filter and never reaches process-level handlers — so the actual detonation
 * is deferred (setTimeout) or fired as a floating promise.
 *
 * The process survives because main.ts registers
 * process.on('uncaughtException') / process.on('unhandledRejection').
 */
@Controller()
export class FaultsController {
  @Post('/api/faults/uncaught')
  scheduleUncaught(): { scheduled: string } {
    setTimeout(() => detonateUncaught(), 25);
    return { scheduled: 'uncaughtException' };
  }

  @Post('/api/faults/unhandled')
  scheduleUnhandled(): { scheduled: string } {
    detonateUnhandled();
    return { scheduled: 'unhandledRejection' };
  }
}

/** Named on purpose: breakpoints and stack frames must be recognizable. */
export function detonateUncaught(): void {
  throw new Error('e2e-boom-uncaught');
}

/** Named on purpose: breakpoints and stack frames must be recognizable. */
export function detonateUnhandled(): void {
  void Promise.reject(new Error('e2e-boom-unhandled'));
}
