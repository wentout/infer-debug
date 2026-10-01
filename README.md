# infer-debug

In-process debug proxy for **Node.js** applications — framework-agnostic core
with adapters for **NestJS**, **Express**, **Fastify**, or a plain
`http.Server`.

## The story

Imagine the situation. Something is wrong on your **dev stand** — a request
misbehaves only there, with real data, real headers, real everything. You know
exactly which line you'd put a breakpoint on. But the app runs in a Kubernetes
pod, and your DevOps engineer doesn't want to expose port **9229** on it — and
honestly, they're right not to.

And even if they did — what next? How would you even figure out how port would
be yours and how to tunnel into it, how not to freeze the pod ( and its health
checks inside of it ) the moment your breakpoint hits?

The answer: **you're not alone, and from now you don't have to figure out ...**

## The solution

Attach Chrome DevTools to **selected endpoints** of a running app — locally, on a
dev stand, or in a Kubernetes pod — **through the one HTTP port the app already
exposes.** No new ports, no ingress rules, no `--inspect` on the main process.

Why not just `--inspect` the app itself? Because a paused breakpoint would freeze
**all** traffic (including health checks), corrupt OpenTelemetry spans mid-flight,
and stall background workers (Kafka consumers, schedulers). Instead, this module
spawns a **child process** — a second copy of your app, with `--inspect` — and
proxies only the requests you choose into it. Everything else is served by the
main process, untouched. The DevTools protocol is tunnelled through the same
port, so `chrome://inspect` just works — even through an SSH hop or an ingress.

## How it works

```
Client ──► Main app (port N) ──► header-marked requests proxied ──► Child app (port N+1, --inspect)
                │                                                              ▲
                └── <basePath>/* control API, /json/* inspector discovery ─────┘
                └── WebSocket tunnel to the child's Node inspector ◄── chrome://inspect
```

- The child is spawned on demand (`POST <basePath>/start`) from the same entry file
  the host was launched with, with identical env except the HTTP port.
- You choose which requests go to the child by sending its trigger header
  (default: `infer-debug`) — any request carrying it is proxied. Proxied
  responses carry the same header with a DevTools deep link that jumps straight
  to the child's inspector. Route tables stay an app-side concern — see
  [`examples/nest-route-table`](examples/nest-route-table).
- Auto-stop after 3 minutes idle, with zombie detection (a child that refuses
  SIGTERM blocks new sessions until cleaned up).
- Deep architecture notes: [`infer-debug-architecture.md`](infer-debug-architecture.md).

> **Security note (honest one).** The trigger header is *marking*, not
> authentication — anyone who can reach the app port can send it, and the
> inspector UUID in the WS path is unguessability, not a boundary. Treat the
> app port as the trust surface: keep the debug child internal, let your
> ingress/VPN do the guarding, and rely on auto-stop to keep sessions short.

## Install

```bash
npm install infer-debug        # once published
# or during local development:
npm install file:../infer-debug
```

Peer dependencies are **all optional** — install only the ones for the adapter
you use: `@nestjs/common`/`@nestjs/core`/`@nestjs/swagger`/
`@nestjs/platform-express` (all ^11) for NestJS, `express` (^4/^5) for Express,
`fastify` (^4/^5) for Fastify, nothing at all for raw Node.

> **Migrating from 0.2.x:** the root entry is now the framework-free core. The
> NestJS wiring moved to a subpath — change
> `import { InferDebugModule } from 'infer-debug'` to
> `import { InferDebugModule } from 'infer-debug/nestjs'`. Nothing else changes.

## Quickstart (NestJS)

```typescript
// app.module.ts
import { InferDebugModule } from 'infer-debug/nestjs';

@Module({
  imports: [InferDebugModule.forRoot()],
})
export class AppModule {}
```

```typescript
// main.ts (optional but recommended)
import { setupInferDebugDocs, stripInferDebugPaths } from 'infer-debug/nestjs';

const factory = (): OpenAPIObject =>
  stripInferDebugPaths(SwaggerModule.createDocument(app, config)); // keep main /docs clean
SwaggerModule.setup('docs', app, factory);

setupInferDebugDocs(app); // own UI at /infer-debug/docs, JSON at /infer-debug/docs-json
```

Start the app with `INFER_DEBUG=true` in the environment, then from your laptop:

```bash
npx infer-debug https://api.example.com 9229
```

That single command: asks the server to spawn the debug child and opens a local
WebSocket bridge on `127.0.0.1:9229`. Then call any endpoint with the trigger
header — it is served **by the child**:

```bash
curl -H 'infer-debug: 1' https://api.example.com/your-debugged-url
```

The response carries an `infer-debug` header with a `devtools://` deep link —
paste it into Chrome and you're attached to the child, through the app's own
port. Point `chrome://inspect` at `127.0.0.1:9229` as the alternative — either
way your breakpoint fires **in the child**, while the main process keeps
serving everyone else.

Full runnable version: [`examples/nestjs`](examples/nestjs).

## Quickstart (Express)

```javascript
const { InferDebugCore } = require('infer-debug');
const { createInferDebugMiddleware } = require('infer-debug/express');

const core = new InferDebugCore({ childPortEnvVar: 'PORT' });
app.use(createInferDebugMiddleware(core));           // before your routes
const server = app.listen(3000, () => core.attachServer(server));
// on shutdown: core.close();
```

Full runnable version: [`examples/express`](examples/express).

## Quickstart (Fastify)

```javascript
const { inferDebugFastifyPlugin } = require('infer-debug/fastify');

fastify.register(inferDebugFastifyPlugin, { childPortEnvVar: 'PORT' });
// routes first, then await fastify.ready() — the WS tunnel + port discovery
// attach in the onReady hook, the child stops in onClose.
// The core is reachable as fastify.inferDebug for programmatic control.
```

Full runnable version: [`examples/fastify`](examples/fastify).

## Quickstart (raw Node)

```javascript
const { InferDebugCore } = require('infer-debug');
const core = new InferDebugCore({ childPortEnvVar: 'APP_PORT' });
const server = http.createServer((req, res) => {
  if (core.handleHttp(req, res)) return;  // control API, /json/*, marked
  // ... your app ...
});
server.listen(3000, () => core.attachServer(server));
```

Full runnable version: [`examples/raw-node`](examples/raw-node).

## Writing your own adapter (Koa, Hono, anything)

The shipped NestJS / Express / Fastify adapters are **reference
implementations**, not the boundary of what works — the Express one is 8 lines
of code. The core is framework-free; plugging it into any other framework or
your own routing layer is a four-call contract:

1. `const core = new InferDebugCore(options)` — same `TInferDebugOptions`
   everywhere.
2. At the framework's **earliest pre-routing stage**, give the core first
   refusal: `if (core.handleHttp(req, res)) return;` — it answers the control
   API, `/json/*` discovery, and header-marked requests; everything else falls
   through to your app. If the framework must commit to manual response
   handling *before* you answer (like Fastify's `reply.hijack()`), pre-check
   with `core.shouldHandle(req)` — true exactly when `handleHttp` will handle.
3. Once the HTTP server exists: `core.attachServer(server)` — discovers the
   app port (child gets port+1) and installs the WS upgrade hook.
   This is server-level, so it works identically under any framework. The
   hook answers three kinds of upgrade: the uuid-shaped inspector path
   (DevTools tunnel), and — new — any OTHER upgrade carrying the trigger
   header is relayed wholesale to the secondary process (the header is
   consumed, never forwarded); upgrades without the header are left to your
   app. Marked upgrades get a clean `503` while the secondary is down.
4. On shutdown: `core.close()` — stops the debug child.

Three things that bite when hand-rolling:

- **Original URL.** The core matches on `req.originalUrl ?? req.url`. If your
  framework rewrites `req.url` while mounting middleware, pass the original.
- **Raw req/res.** Hand the core the raw Node `http.IncomingMessage` /
  `ServerResponse` (e.g. Fastify's `request.raw` / `reply.raw`), not framework
  wrapper objects.
- **Parsed bodies.** If a body parser ran before you, leave the parsed value
  on `req.body` — the core re-sends it with a recalculated `Content-Length`.

Skeleton for a middleware-style framework (Koa shown; others look the same):

```javascript
const { InferDebugCore } = require('infer-debug');
const core = new InferDebugCore({ childPortEnvVar: 'PORT' });

app.use(async (ctx, next) => {
  if (core.shouldHandle(ctx.req)) {
    ctx.respond = false;               // we take over the raw response
    core.handleHttp(ctx.req, ctx.res); // control API, /json/*, marked
    return;
  }
  await next();
});

const server = http.createServer(app.callback());
server.listen(3000, () => core.attachServer(server));
```

## Enabling / disabling

The `enabled` option is the master switch. Three ways to drive it:

```typescript
InferDebugModule.forRoot({ enabled: true });                    // explicit
InferDebugModule.forRoot();                                     // env INFER_DEBUG === 'true'
InferDebugModule.forRoot({ enabledEnvVar: 'MY_DEBUG_FLAG' });   // your own env var name
```

The env var is only a convention — feel free to ignore it and feed `enabled` from
your own config system (`forRootAsync` works too).

## Options

Same `TInferDebugOptions` object everywhere: the NestJS `forRoot` /
`forRootAsync`, the Fastify plugin's register options, or the
`new InferDebugCore(options)` constructor for Express / raw Node.

| Option | Default | Meaning |
|--------|---------|---------|
| `enabled` | env `INFER_DEBUG === 'true'` | Master switch. When false: no proxying, no upgrade hook, control endpoints report `disabled`. |
| `enabledEnvVar` | `'INFER_DEBUG'` | Name of the env var consulted for the `enabled` default. |
| `basePath` | `'/infer-debug'` | URL prefix of the control API (see below). |
| `headerName` | `'infer-debug'` | Trigger header: requests carrying it go to the child; proxied responses carry it back with a DevTools deep link to the child's inspector. Normalized to lowercase. |
| `inspectorPort` | `9229` | Node inspector port of the child (loopback only). |
| `childPort` | auto | Exact HTTP port for the child. Default: the app's bound port + 1, discovered from the server's `listening` event. |
| `childEntry` | `process.argv[1]` | Entry file spawned as the child — see "Using a different entrypoint". |
| `childPortEnvVar` | `'APP_PORT'` | Env var used to tell the child its HTTP port. |
| `childReadyStdoutPattern` | — (skip) | If set, startup first waits for this pattern in the child's stdout, e.g. `/Server listening on port/i`. |
| `healthcheckPath` | — (TCP probe) | If set, readiness = GET on this path returning < 500 (e.g. `/healthcheck`). Otherwise a plain TCP connect is used. |
| `idleTimeoutMs` | `180000` | Auto-stop the child after this much inactivity. |
| `idleCheckIntervalMs` | `10000` | Idle check cadence. |
| `logBufferSize` | `1000` | Child log lines kept for `<basePath>/logs` + debugger detection. |

Note: in `forRootAsync`, `basePath` stays a **static** property (route decorators are
fixed at module-declaration time); the rest can come from your `useFactory`.

### Using a different entrypoint

```typescript
import { InferDebugModule, resolveChildEntry } from 'infer-debug/nestjs';

InferDebugModule.forRoot({
  childEntry: resolveChildEntry('dist/worker/main.js'), // resolved against process.cwd()
});
```

## Control API

All endpoints live under `basePath` (default `/infer-debug`):

| Endpoint | Purpose |
|----------|---------|
| `GET <basePath>/available` | `{status: 'ok'}` or `{status: 'no', reason}` (`disabled` / `zombie present` / `debugger attached`) |
| `GET <basePath>/status` | e.g. `running: no zombie: debugger detached` |
| `POST <basePath>/start` / `POST <basePath>/stop` | Child lifecycle |
| `GET <basePath>/logs?lines=N` / `DELETE <basePath>/logs` | Child stdout/stderr buffer |

### Why `/json/list` and `/json/version` also appear

These two are **not ours** — they belong to the Node.js inspector discovery protocol.
Chrome DevTools (`chrome://inspect`) looks for exactly these URLs to find debuggable
targets; there is no way to rename or avoid them. The module proxies them to the
child's inspector. They are inert when no debug session is active: the controller
answers `404` unless the child is running and ready.

## CLI (`infer-debug`)

The server side is only half of the story. Chrome DevTools speaks WebSocket to a
Node inspector that listens on a **loopback port inside your server/pod** — it can't
reach it directly. The CLI is the laptop-side bridge that closes that gap. One
command runs the whole session flow:

1. `GET <basePath>/available` — refuse early if a debugger is attached or a zombie child exists
2. `POST <basePath>/start` and poll until the child is `running` — fails fast if the
   status flips back to `stopped` (child died during start) or reports
   `has zombie` / `error`, instead of burning the full 2-minute timeout
3. print inspector info (`/json/version`, `/json/list`) and recent child logs
4. open a local HTTP/WS proxy on `127.0.0.1:<localPort>` — the address you paste into `chrome://inspect`

```
infer-debug <host> [localPort]

  infer-debug localhost:3000
  infer-debug https://api.example.com 9229
  infer-debug http://staging.internal:8080
```

Once the child is running, route requests into it with the trigger header —
from curl, from your gateway, or from an app-side route table
([`examples/nest-route-table`](examples/nest-route-table)):

```bash
curl -H 'infer-debug: 1' https://api.example.com/api/orders/42
```

The proxied response answers with the same header holding a `devtools://` deep
link (`ws=<app-host>/<inspector-target>` — the inspector WS is tunnelled at the
same path on the app port), so the jump to the secondary debuggable process is
one paste away, no CLI bridge strictly required for attaching.

- `infer-debug --help` (or `-h`, or no arguments) prints the full usage and exits.
- Host may also come from `INFER_DEBUG_HOST`.
- Local proxy port may also come from `INFER_DEBUG_PORT` (default 9229). If the
  port is already taken, the CLI exits with a clear `EADDRINUSE` message instead
  of a raw stack.
- The local proxy rewrites loopback `webSocketDebuggerUrl` values in `/json/list`
  and `/json/version` responses to `localPort`, so targets discovered via
  `chrome://inspect` stay clickable when `localPort` differs from the child's
  inspector port (9229).
- **Protocol**: a full URL scheme is honored (`http://` stays plain HTTP — handy for
  plain-HTTP stands). A bare host means HTTPS for remote, HTTP for localhost.
  Self-signed certs are tolerated for HTTPS.
- Control API prefix: `--base-path=/custom` or `INFER_DEBUG_BASE_PATH`
  (must match the server's `basePath` option).

The CLI stays in the foreground serving the local DevTools proxy; closing it
ends your local side of the session. The server-side child stops on its own
after the idle timeout (3 minutes by default), so an abandoned session cleans
itself up.

**What counts as activity:** only traffic that passes through infer-debug —
control API calls, requests proxied to the child, and CDP frames flowing
through this CLI bridge. A debugger attached **directly to the child's
inspector port** (9229) bypasses the proxy and does **not** reset the idle
timer, so a quiet direct session is auto-stopped after the timeout even while
DevTools is open. Attaching through the bridge keeps the session alive for
free; for long direct sessions, raise `idleTimeoutMs` in `forRoot()`.

## TypeScript stack traces (source maps)

Production apps usually run `node --enable-source-maps` — that is the only way
to see `.ts` lines in stack traces. The package's build (and the e2e fixture)
ships `inlineSourceMap` + `inlineSources`, so when your app runs with that flag,
frames inside the debug child — including `uncaughtException` /
`unhandledRejection` logs — point at the **TypeScript sources**:

```
[fixture] uncaughtException captured:
Error: e2e-boom-uncaught
    at detonateUncaught (/app/e2e/fixture/faults.controller.ts:29:9)
    at Timeout._onTimeout (/app/e2e/fixture/faults.controller.ts:16:22)
```

The child inherits `NODE_OPTIONS` (and the rest of the environment) from the
main process, so no extra wiring is needed — run your app the way you already do.

## Wrap-proxy (`infer-debug-wrap`) — the alternative

Don't want to (or can't) touch the app's modules? `infer-debug-wrap` is a standalone
script that spawns your app itself under `--inspect` and proxies **everything** to it:
all HTTP traffic, `/json/*`, and all WebSocket upgrades. No route selectivity — every
request hits the debugged process. Good for local sessions.

```bash
npx infer-debug-wrap dist/src/main.js 3000
# app runs on 3001, inspector on 9229, you talk to 3000 as usual
```

## Design notes worth a discussion

- **Header-triggered proxying** — any request carrying the trigger header goes to
  the child, all methods alike; the header is consumed by the proxy and never
  forwarded (the child runs the same module — forwarding would chase a
  grandchild that doesn't exist). Route tables are deliberately the app's
  concern, not the module's (see `examples/nest-route-table`).
- **127.0.0.1 over localhost** for the inspector — Chrome DevTools CSP treats the IP
  form more reliably. Make as many hops as needed, they all stay on loopback. :)

## Notes for `file:`-linked development

- npm links `file:` deps as symlinks — rebuild the package (`npm run build`) after
  every edit here; the consumer picks up `dist/` immediately.
- **Single `@nestjs/*` copy rule**: the package must resolve `@nestjs/common|core|swagger`
  from the *consumer's* `node_modules`, otherwise the consumer build fails on nominal
  type mismatches and DI tokens (`HttpAdapterHost`) diverge at runtime. When developing
  linked, symlink the package's copies back to the consumer's:
  ```bash
  cd /path/to/infer-debug/node_modules/@nestjs
  for p in common core swagger; do
    rm -rf "$p" && ln -s "/path/to/consumer/node_modules/@nestjs/$p" "$p"
  done
  ```

## Development

```bash
npm install
npm run build
npm test
```

## E2E & Docker

The package ships a self-contained end-to-end setup under `e2e/`: a tiny fixture
NestJS app (`GET /api/orders/:id` reports `process.pid`; `POST /api/faults/*`
deliberately triggers `uncaughtException` / `unhandledRejection` outside the
request context) and a jest suite that proves the whole chain on a live app —
header-marked proxying (the answering pid changes, and the response carries the
DevTools jump link back), unmarked requests staying on the
main process, DevTools discovery via `/json/list`, a real CDP session through
the app port (breakpoint in the orders controller, live variable inspection,
resume), and process-level fault logs whose stacks point at the **TypeScript
sources** (source maps, see above).

```bash
# locally (spawns the fixture app itself)
npm run test:e2e

# fully containerized: fixture app + e2e runner in docker
npm run compose:e2e
```

The docker variant publishes only the main HTTP port (4123); the debug child and
the inspector stay on loopback inside the container, so the suite also
demonstrates debugger access tunnelled through the single app port — the exact
scenario the package is built for. The e2e runner needs Node.js >= 22 (built-in
WebSocket client for CDP).

### Runnable adapter examples (Docker)

The same one-port scenario is packaged per adapter under `examples/` — one
container each for Express, Fastify, and NestJS, each publishing only its app
port (3001/3002/3003):

```bash
npm run compose:examples        # build + start all three
node bin/infer-debug.js http://localhost:3002   # drive any of them with the CLI
```

### Demo path

Want to show someone how it feels, end to end?

```bash
# 1. terminal 1 — the "production" app (fixture stands in for it)
INFER_DEBUG=true node e2e/dist/main.js        # after: npm run build && npm run build:e2e

# 2. terminal 2 — your laptop side
npx infer-debug 127.0.0.1:4123

# 3. Chrome → chrome://inspect → inspect 127.0.0.1:9229
# 4. Set a breakpoint in faults.controller.ts → detonateUncaught, then send the
#    trigger header so the request lands in the child:
curl -X POST -H 'infer-debug: 1' http://127.0.0.1:4123/api/faults/uncaught -i
#    (-i shows the answer's own infer-debug header: a devtools:// jump link)

# 5. The child pauses at the throw, in the .ts source. Resume, then read the
#    captured process-level fault with its TypeScript tracepath:
curl 'http://127.0.0.1:4123/infer-debug/logs?lines=50'
```

## License

MIT — see [LICENSE](LICENSE).
