import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { InferDebugModule } from './infer-debug.module';
import { DEFAULT_BASE_PATH, normalizeBasePath } from './infer-debug.options';

export type TInferDebugDocsOptions = {
  /**
   * Where the infer-debug Swagger UI is mounted.
   * Default: 'infer-debug/docs' (UI at /infer-debug/docs, JSON at /infer-debug/docs-json).
   */
  path?: string;
};

/**
 * Mounts a SEPARATE Swagger UI containing only the infer-debug control endpoints.
 * The host app's own Swagger document is never touched — see
 * {@link stripInferDebugPaths} for keeping those endpoints out of it.
 */
export function setupInferDebugDocs(app: INestApplication, options: TInferDebugDocsOptions = {}): void {
  const path = options.path ?? 'infer-debug/docs';
  const config = new DocumentBuilder()
    .setTitle('Debug Proxy')
    .setDescription('Debug proxy configuration endpoints')
    .setVersion('0.1.0')
    .build();
  const factory = (): OpenAPIObject => SwaggerModule.createDocument(app, config, { include: [InferDebugModule] });
  SwaggerModule.setup(path, app, factory);
}

/**
 * Removes all infer-debug paths from an existing OpenAPI document.
 * Use inside the host app's main Swagger factory so the standard docs stay clean:
 *
 * ```typescript
 * const factory = (): OpenAPIObject =>
 *   stripInferDebugPaths(SwaggerModule.createDocument(app, config));
 * SwaggerModule.setup('docs', app, factory);
 * ```
 *
 * Pass the same basePath you gave the module if you overrode it.
 */
export function stripInferDebugPaths(document: OpenAPIObject, basePath: string = DEFAULT_BASE_PATH): OpenAPIObject {
  const prefix = normalizeBasePath(basePath);
  Object.keys(document.paths).forEach((path) => {
    if (path === prefix || path.startsWith(`${prefix}/`) || path === '/json/list' || path === '/json/version') {
      delete document.paths[path];
    }
  });
  return document;
}
