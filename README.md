# infer-debug

In-process debug proxy for **NestJS (Express)** applications.

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
Client ──► Main NestJS app (port N) ──► matched routes proxied ──► Child app (port N+1, --inspect)
                │                                                              ▲
                └── <basePath>/* control API, /json/* inspector discovery ─────┘
                └── WebSocket tunnel to the child's Node inspector ◄── chrome://inspect
```

- The child is spawned on demand (`POST <basePath>/start`) from the same entry file
  the host was launched with, with identical env except the HTTP port.
- You register which routes go to the child using swagger-style templates:
  `/api/orders/{id}`, `/api/orders/{*}` (subtree wildcard).
- Auto-stop after 3 minutes idle, with zombie detection (a child that refuses
  SIGTERM blocks new sessions until cleaned up).
- Deep architecture notes: [`infer-debug-architecture.md`](infer-debug-architecture.md).

## Install

```bash
npm install infer-debug        # once published
# or during local development:
npm install file:../infer-debug
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/swagger`,
`@nestjs/platform-express` (all ^11), `express`.

## Quickstart

```typescript
// app.module.ts
import { InferDebugModule } from 'infer-debug';

@Module({
  imports: [InferDebugModule.forRoot()],
})
export class AppModule {}
```

```typescript
// main.ts (optional but recommended)
import { setupInferDebugDocs, stripInferDebugPaths } from 'infer-debug';

const factory = (): OpenAPIObject =>
  stripInferDebugPaths(SwaggerModule.createDocument(app, config)); // keep main /docs clean
SwaggerModule.setup('docs', app, factory);

setupInferDebugDocs(app); // own UI at /infer-debug/docs, JSON at /infer-debug/docs-json
```

Start the app with `INFER_DEBUG=true` in the environment, then from your laptop:

```bash
npx infer-debug https://api.example.com 9229 '/your-debugged-url'
```

That single command: asks the server to spawn the debug child, registers
`/your-debugged-url` for proxying, and opens a local WebSocket bridge on
`127.0.0.1:9229`. Point `chrome://inspect` at `127.0.0.1:9229`, call
`/your-debugged-url` — your breakpoint fires **in the child**, while the main
process keeps serving everyone else.

## Enabling / disabling

The `enabled` option is the master switch. Three ways to drive it:

```typescript
InferDebugModule.forRoot({ enabled: true });                    // explicit
InferDebugModule.forRoot();                                     // env INFER_DEBUG === 'true'
InferDebugModule.forRoot({ enabledEnvVar: 'MY_DEBUG_FLAG' });   // your own env var name
```

The env var is only a convention — feel free to ignore it and feed `enabled` from
your own config system (`forRootAsync` works too).

## Options (`forRoot` / `forRootAsync`)

| Option | Default | Meaning |
|--------|---------|---------|
| `enabled` | env `INFER_DEBUG === 'true'` | Master switch. When false: no proxying, no upgrade hook, control endpoints report `disabled`. |
| `enabledEnvVar` | `'INFER_DEBUG'` | Name of the env var consulted for the `enabled` default. |
| `basePath` | `'/infer-debug'` | URL prefix of the control API (see below). |
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
import { InferDebugModule, resolveChildEntry } from 'infer-debug';

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
| `GET/POST/DELETE <basePath>/routes` | Route registry (POST body: `text/plain`, one template per line) |
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
2. `POST <basePath>/start` and poll until the child is `running`
3. print inspector info (`/json/version`, `/json/list`) and recent child logs
4. merge your routes into the registry (`POST <basePath>/routes`)
5. open a local HTTP/WS proxy on `127.0.0.1:<localPort>` — the address you paste into `chrome://inspect`

```
infer-debug <host> [localPort] [/route ...]

  infer-debug localhost:3000 '/api/orders/{id}'
  infer-debug https://api.example.com 9229 '/your-debugged-url'
  infer-debug http://staging.internal:8080 '/api/orders/{*}'
```

- `infer-debug --help` (or `-h`, or no arguments) prints the full usage and exits.
- Every positional after the host must be a **route starting with `/`** (or a full
  `http(s)://` URL to take the path from). Anything else — and any unknown
  `--option` — fails loudly with the usage text instead of being silently
  misread as a route.
- Host may also come from `INFER_DEBUG_HOST`.
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

- **Path-only route matching** — all HTTP methods of a matched path go to the child.
  Method-specific matching is possible; open an issue if you need it.
- **Express only** — Fastify adapter is not implemented yet; open an issue and we'll add it.
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
route proxying (the answering pid changes), non-proxied routes staying on the
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

### Demo path

Want to show someone how it feels, end to end?

```bash
# 1. terminal 1 — the "production" app (fixture stands in for it)
INFER_DEBUG=true node e2e/dist/main.js        # after: npm run build && npm run build:e2e

# 2. terminal 2 — your laptop side
npx infer-debug 127.0.0.1:4123 '/api/orders/{*}' '/api/faults/{*}'

# 3. Chrome → chrome://inspect → inspect 127.0.0.1:9229
# 4. Set a breakpoint in faults.controller.ts → detonateUncaught, then:
curl -X POST http://127.0.0.1:4123/api/faults/uncaught

# 5. The child pauses at the throw, in the .ts source. Resume, then read the
#    captured process-level fault with its TypeScript tracepath:
curl 'http://127.0.0.1:4123/infer-debug/logs?lines=50'
```

## License

MIT — see [LICENSE](LICENSE).
