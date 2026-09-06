// NestJS adapter entry ('infer-debug/nestjs'). Options and the core types are
// re-exported from the root for one-stop imports.
export { InferDebugModule, TInferDebugAsyncOptions } from './infer-debug.module';
export { InferDebugService, TInferDebugStatus, TZombieInfo } from './infer-debug.service';
export { InferDebugMiddleware } from './infer-debug.middleware';
export { setupInferDebugDocs, stripInferDebugPaths, TInferDebugDocsOptions } from './swagger';
export { TInferDebugOptions, TResolvedInferDebugOptions, resolveInferDebugOptions, resolveChildEntry } from './infer-debug.options';
export { InferDebugCore, buildDevtoolsJumpUrl } from './index';
