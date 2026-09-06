// Root entry: the framework-free core only. Framework wiring lives at
// subpaths — 'infer-debug/nestjs', 'infer-debug/express', 'infer-debug/fastify'
// — so importing the root never loads @nestjs/*, express, or fastify.
export { InferDebugCore, TInferDebugStatus, TZombieInfo, isInspectorUpgradePath } from './core/infer-debug-core';
export { TRequestLike, TResponseLike, TInferDebugLogger, consoleInferDebugLogger } from './core/http-like';
export {
  TInferDebugOptions,
  TResolvedInferDebugOptions,
  resolveInferDebugOptions,
  resolveChildEntry,
  normalizeBasePath,
  DEFAULT_BASE_PATH,
  DEFAULT_HEADER_NAME,
} from './infer-debug.options';
export { buildDevtoolsJumpUrl } from './models/devtools-url';
export { CircularBuffer } from './models/circular-buffer';
