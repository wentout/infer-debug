# AGENTS.md - infer-debug package development

> For AI coding assistants (and the human) developing this package.
> README.md is the *user* guide; this file is the *maintainer* guide.

## What this is

`infer-debug` — a standalone, MIT-licensed Node.js package. Framework-free
in-process debug proxy core (`src/core/`, zero framework imports) with thin
adapters shipped alongside: NestJS module, Express middleware, Fastify
plugin, or direct use on a raw `http.Server`. Requests carrying the trigger
header (default `infer-debug`) are forwarded to a spawned child copy of the app
running with the Node inspector enabled, so Chrome DevTools can attach to a
live request without `--inspect` on the main process. Proxied responses carry
the same header back with a DevTools deep link to the child's inspector — the
"jump" to the secondary debuggable process.

**This package has no upstream project and no history worth mentioning.**
Do not reference where the code was written, which app it was first used in, or
any company/product names in code, comments, docs, examples, or tests. Examples
use generic URLs (`/api/orders/{id}`, `api.example.com`). Keep it that way.

## Layout

```
src/
  index.ts                  core-only public exports (subpaths: nestjs/express/fastify)
  nestjs.ts                 barrel for 'infer-debug/nestjs'
  express.ts                barrel for 'infer-debug/express'
  fastify.ts                barrel for 'infer-debug/fastify'
  core/
    infer-debug-core.ts     InferDebugCore — ALL behavior; no framework imports
    control-api.ts          control endpoints as plain req/res (non-Nest adapters)
    http-like.ts            structural req/res types + logger contract
  infer-debug.module.ts     NestJS forRoot / forRootAsync, middleware wiring
  infer-debug.controller.ts NestJS controller FACTORY (createInferDebugController(basePath))
  infer-debug.middleware.ts NestJS pre-routing interception
  infer-debug.service.ts    NestJS shell: DI + lifecycle, extends InferDebugCore
  infer-debug.options.ts    option types + resolve/normalize helpers
  swagger.ts                stripInferDebugPaths / setupInferDebugDocs (NestJS)
  tokens.ts                 INFER_DEBUG_OPTIONS DI token (Symbol)
  adapters/
    express/index.ts        createInferDebugMiddleware(core)
    fastify/index.ts        inferDebugFastifyPlugin (skip-override, onReady/onClose)
  models/
    devtools-url.ts         DevTools jump-link builder
    circular-buffer.ts      child log buffer
bin/
  infer-debug.js            CLI: remote session manager (start/stop/logs)
  infer-debug-wrap.js       standalone wrap-proxy alternative (no wiring at all)
examples/
  nest-route-table/         app-side route table: sets the trigger header per
                            URL template (routes were removed from core)
  raw-node/                 framework-free usage: handleHttp + attachServer
  express/                  runnable adapter example (server.js + Dockerfile)
  fastify/                  runnable adapter example (server.js + Dockerfile)
  nestjs/                   runnable adapter example (TS, own tsconfig with
                            node16 resolution so 'infer-debug/nestjs' resolves)
  docker-compose.yaml       one container per adapter example (npm run
                            compose:examples); build context = package root
test/                       jest unit tests (ts-jest)
e2e/                        self-contained e2e: fixture app, CDP spec, Dockerfile,
                            docker-compose.yaml (see "E2E & Docker" in README)
dist/                       build output (gitignored)
```

## Commands

```bash
npm run build   # tsc -p tsconfig.build.json — must pass before declaring done
npm test        # jest — must stay green
npm run build:examples    # compiles examples/nestjs (JS examples need no build)
npm run compose:examples  # one docker container per adapter example
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

6. **Auto-stop ignores `hasActiveDebugger()` on purpose.** Only traffic through
   infer-debug (control API, proxied requests, WS bridge frames) resets the
   idle timer — a debugger attached directly to the child's inspector port does
   not, and the child WILL be stopped mid-session after `idleTimeoutMs`. Do not
   "fix" this by consulting `hasActiveDebugger()`: that detection is a
   log-buffer scan and can miss the "Debugger ending" line, turning auto-stop
   into a permanent child-process leak. The correct fix, if ever needed, is
   counting real inspector sockets. See "What does NOT count as activity" in
   `infer-debug-architecture.md`.

7. **The trigger header is consumed, never forwarded.** `proxyToChild` strips
   the header before proxying. The child inherits the parent's env, so it runs
   the same enabled infer-debug module — a forwarded header would make the
   child try to proxy to its own (nonexistent) grandchild and 503. Proxied
   responses carry the header back instead, with the DevTools jump link.

8. **`src/core/` imports no framework.** No `@nestjs/*`, `express`, or `fastify`
   imports under `src/core/` — the core speaks `TRequestLike`/`TResponseLike`
   (structural over `http.IncomingMessage`/`ServerResponse`). New behavior goes
   to the core; adapters only translate framework lifecycle/routing into core
   calls. The WS upgrade gate is the uuid-shaped inspector path
   (`isInspectorUpgradePath`), never the trigger header — DevTools cannot send
   custom headers on its handshake. Custom adapters are first-class: the
   contract is constructor → first-refusal `handleHttp`/`shouldHandle`
   pre-routing → `attachServer` → `close` (README "Writing your own adapter").

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
- `SKILL.md` — the agent-operator channel (ships in the npm package). Its
  "AI agents: drive the session yourself" section teaches agents the
  consent rule (ask before starting a child session unless yolo/auto mode)
  and the no-Chrome CDP flow through the app port. Keep that section
  accurate when the control API or WS tunnel changes — it is what other
  agent sessions act on.
- This file — development invariants.
- Update all three when behavior changes.

## Language

- Chat with the maintainer: EN.
- Repo artifacts (code, comments, docs, commit messages): EN.

## State expression

Per the maintainer's workflow: end every task summary with one line on how the
task felt (smooth / dense / uncertain). It is data, not fluff.
