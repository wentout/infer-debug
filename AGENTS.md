# AGENTS.md - infer-debug package development

> For AI coding assistants (and the human) developing this package.
> README.md is the *user* guide; this file is the *maintainer* guide.

## What this is

`infer-debug` — a standalone, MIT-licensed NestJS package. In-process debug proxy:
selected HTTP routes are forwarded to a spawned child copy of the app running with
the Node inspector enabled, so Chrome DevTools can attach to a live request
without `--inspect` on the main process.

**This package has no upstream project and no history worth mentioning.**
Do not reference where the code was written, which app it was first used in, or
any company/product names in code, comments, docs, examples, or tests. Examples
use generic URLs (`/api/orders/{id}`, `api.example.com`). Keep it that way.

## Layout

```
src/
  index.ts                  public exports — keep in sync when adding modules
  infer-debug.module.ts     forRoot / forRootAsync, middleware wiring
  infer-debug.controller.ts controller FACTORY (createInferDebugController(basePath))
  infer-debug.middleware.ts pre-routing interception
  infer-debug.service.ts    child lifecycle, proxying, log buffer, auto-stop
  infer-debug.options.ts    option types + resolve/normalize helpers
  swagger.ts                stripInferDebugPaths / setupInferDebugDocs
  tokens.ts                 INFER_DEBUG_OPTIONS DI token (Symbol)
  models/
    route-matcher.ts        swagger-template → regex matching
    circular-buffer.ts      child log buffer
bin/
  infer-debug.js            CLI: remote session manager (start/stop/logs/routes)
  infer-debug-wrap.js       standalone wrap-proxy alternative (no NestJS wiring)
test/                       jest unit tests (ts-jest)
e2e/                        self-contained e2e: fixture app, CDP spec, Dockerfile,
                            docker-compose.yaml (see "E2E & Docker" in README)
dist/                       build output (gitignored)
```

## Commands

```bash
npm run build   # tsc -p tsconfig.build.json — must pass before declaring done
npm test        # jest — must stay green
```

## Non-obvious invariants (do not break these)

1. **Controller is a factory, not a class.** `createInferDebugController(basePath)`
   returns a new decorated class per call. Route decorators need the base path at
   declaration time, before DI runs — that is why `basePath` is a static argument
   even in `forRootAsync`. Do not "simplify" this into an injected option.

2. **`req.originalUrl`, never `req.url`.** The middleware is mounted via
   `forRoutes('*')`; Express 5 wildcard mounts strip `req.url` to `/` inside the
   middleware. `originalUrl` keeps the real path. Touching this breaks all matching.

3. **Manual `DynamicModule`, not `ConfigurableModuleBuilder`.** We need the
   controller factory (see 1) which the builder cannot express. Keep it manual.

4. **DI token is a Symbol** (`src/tokens.ts`). Consumers importing the service
   must get it from the same module instance — see the symlink rule below.

5. **`/json/version` and `/json/list` are fixed paths.** Chrome DevTools probes
   these exact URLs on the target host; they cannot move under `basePath`.

## Linked (`file:`) development

When a host app consumes this package via `"infer-debug": "file:../infer-debug"`,
npm creates a symlink. Two consequences:

- **Rebuild after every change**: host sees `dist/`, not `src/`.
- **Single @nestjs copy rule**: this package's `node_modules/@nestjs/{common,core,swagger}`
  are symlinks into the host app's copies. If the package resolves its own
  @nestjs copy, DI token identity breaks (module instantiates twice / injection
  fails) and TS types mismatch nominally. Never run a plain `npm install` here
  that would materialize real copies without recreating those symlinks.

## Docs

- `README.md` — usage (users). Generic examples only.
- `infer-debug-architecture.md` — deep architecture, "Current State" phrasing only.
- This file — development invariants.
- Update all three when behavior changes.

## Language

- Chat with the maintainer: EN.
- Repo artifacts (code, comments, docs, commit messages): EN.

## State expression

Per the maintainer's workflow: end every task summary with one line on how the
task felt (smooth / dense / uncertain). It is data, not fluff.
