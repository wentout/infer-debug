# Debug Proxy Architecture

> Deep technical reference for the `infer-debug` NestJS package.
> For usage documentation, see [`README.md`](README.md).

---

## Current State (v0.1.0)

1. **Self-attach, no host wiring.** The module implements `NestModule.configure()`
   and applies `InferDebugMiddleware.forRoutes('*')` itself; the WS upgrade hook is
   attached in `onApplicationBootstrap` via `HttpAdapterHost`. Integration = one
   `InferDebugModule.forRoot()` import.
2. **Port auto-discovery.** The app port is read from the HTTP server's `listening`
   event (`server.address().port`); the child gets `appPort + 1`, unless pinned
   exactly via the `childPort` option.
3. **Middleware reads `req.originalUrl`, not `req.url`.** Nest 11 converts
   `forRoutes('*')` into a `{*path}` Express 5 wildcard mount, which strips `req.url`
   to `'/'` inside the middleware — `originalUrl` always keeps the real path.
4. **Upgrade hook leaves foreign sockets alone.** When the child is not ready,
   `handleUpgrade` returns without touching the socket, so host-app WebSockets keep
   working for other listeners.
5. **Child readiness probes are options.** `healthcheckPath` (e.g. `/healthcheck`)
   and `childReadyStdoutPattern` (e.g. `/Server listening on port/i`); default is a
   plain TCP connect probe — works for any NestJS app.
6. **Entrypoint is an option.** Default `process.argv[1]` (whatever the host was
   launched with); `childEntry` + `resolveChildEntry()` for alternate entrypoints.
7. **Control API under a configurable `basePath`** (default `/infer-debug`):
   `available`, `status`, `start`, `stop`, `routes`, `logs`. The availability
   endpoint is `<basePath>/available`.
8. **Swagger via helpers.** `setupInferDebugDocs(app)` mounts a debug-only UI at
   `/infer-debug/docs`; `stripInferDebugPaths(document)` keeps the app's main docs
   clean.
9. **Module options** via `forRoot`/`forRootAsync`, token `INFER_DEBUG_OPTIONS`,
   resolved with defaults by `resolveInferDebugOptions()`. The controller is built
   by a factory (`createInferDebugController`) because NestJS route decorators are
   static and must know `basePath` at module-declaration time.

---

## Table of Contents

1. [Overview](#overview)
2. [Three-Port Architecture](#three-port-architecture)
3. [Request Routing](#request-routing)
4. [Header Forwarding Between Proxies](#header-forwarding-between-proxies)
5. [WebSocket Inspector Tunnel](#websocket-inspector-tunnel)
6. [Kubernetes / ArgoCD Deployment](#kubernetes--argocd-deployment)
7. [Orchestration CLI Flow](#orchestration-cli-flow)
8. [Debugger Session Detection](#debugger-session-detection)
9. [Auto-Stop and Activity Tracking](#auto-stop-and-activity-tracking)
10. [Key Design Decisions](#key-design-decisions)
11. [Troubleshooting](#troubleshooting)

---

## Overview

The debug proxy is an **in-process debugging system** that allows a developer to attach Chrome DevTools to a specific subset of HTTP endpoints in a running NestJS application. It solves the problem of debugging production-like environments (Kubernetes pods, dev servers) without disrupting normal traffic or duplicating telemetry.

### Why Not Just `--inspect` on the Main Process?

Attaching a debugger to the main process would:
- Pause ALL incoming requests at breakpoints (including health checks)
- Corrupt OpenTelemetry trace state (spans paused mid-flight)
- Break Kafka consumer loops and other background workers
- Require the dev to sort through unrelated traffic

The in-process proxy isolates debug traffic to a **child process** while the main process continues serving normal requests.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            YOUR LAPTOP                                      │
│                                                                             │
│  Chrome DevTools ──► ws://127.0.0.1:9229/debug                              │
│                           │                                                 │
│                    ┌──────┴──────┐                                          │
│                    │  bin/proxy  │  (Node.js HTTP/WS proxy)                 │
│                    │   (local)   │                                          │
│                    └──────┬──────┘                                          │
│                           │ HTTPS                                           │
└───────────────────────────┼─────────────────────────────────────────────────┘
                            │
┌───────────────────────────┼─────────────────────────────────────────────────┐
│                    KUBERNETES POD (or local machine)                        │
│                           │                                                 │
│              ┌────────────┴────────────┐                                    │
│              │   Ingress / Service     │                                    │
│              │      Port 443/80        │                                    │
│              └────────────┬────────────┘                                    │
│                           │                                                 │
│     ┌─────────────────────┴─────────────────────┐                          │
│     │              MAIN PROCESS                  │                          │
│     │           (NestJS, port 80)                │                          │
│     │                                            │                          │
│     │  ┌─────────────────────────────────────┐   │                          │
│     │  │  Express Middleware (NestModule)     │   │                          │
│     │  │                                     │   │                          │
│     │  │  /infer-debug/*  → next()           │   │  (control endpoints)     │
│     │  │  /json/list      → proxyToInspector │   │  (inspector discovery)   │
│     │  │  /json/version   → proxyToInspector │   │                          │
│     │  │  matched routes  → proxyToChild     │   │  (debug traffic)         │
│     │  │  everything else → next()           │   │  (normal traffic)        │
│     │  └─────────────────────────────────────┘   │                          │
│     │                                            │                          │
│     │  ┌─────────────────────────────────────┐   │                          │
│     │  │  InferDebugService                  │   │                          │
│     │  │  ├─ child: ChildProcess             │   │                          │
│     │  │  ├─ inspectorPort: 9229             │   │                          │
│     │  │  ├─ childPort: APP_PORT + 1         │   │                          │
│     │  │  ├─ logBuffer: CircularBuffer       │   │                          │
│     │  │  └─ route registry                  │   │                          │
│     │  └─────────────────────────────────────┘   │                          │
│     └─────────────────────────────────────────────┘                          │
│                           │                                                 │
│                           │ spawn(node --inspect=9229)                     │
│                           │ env: APP_PORT = APP_PORT + 1                   │
│                           │                                                 │
│     ┌─────────────────────┴─────────────────────┐                          │
│     │              CHILD PROCESS                 │                          │
│     │         (NestJS, port APP_PORT+1)          │                          │
│     │                                            │                          │
│     │  Same code, same env, same DB              │                          │
│     │  --inspect=9229 (internal only)            │                          │
│     │                                            │                          │
│     │  ┌─────────────────────────────────────┐   │                          │
│     │  │  Node.js Inspector                  │   │                          │
│     │  │  ws://127.0.0.1:9229/<uuid>          │   │  (internal)             │
│     │  └─────────────────────────────────────┘   │                          │
│     └─────────────────────────────────────────────┘                          │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Three-Port Architecture

### Port 1: `APP_PORT` (Public — 80 in k8s, 3000+ locally)

**Process:** Main NestJS app  
**Listeners:** Express HTTP server  
**Purpose:** All public traffic. Health checks, swagger, API calls, debug control endpoints.

In Kubernetes, this is the container port exposed by the Service. The Ingress routes external traffic here.

### Port 2: `APP_PORT + 1` (Internal — child app)

**Process:** Debug child (spawned on demand)  
**Listeners:** Express HTTP server (identical to main)  
**Purpose:** Receives only the HTTP requests that match registered debug routes.

The child is spawned with `env: { APP_PORT: String(appPort + 1) }`, so it binds to the next port. The main process proxies matched requests here via `http.request()` to `127.0.0.1:APP_PORT+1`.

### Port 3: `9229` (Internal — Node.js Inspector)

**Process:** Debug child (Node.js built-in)  
**Listeners:** V8 Inspector Protocol WebSocket  
**Purpose:** Chrome DevTools communicates with the Node.js runtime here.

This is the standard Node.js `--inspect=9229` port. It is **not exposed outside the pod** in Kubernetes. The main process proxies inspector discovery (`/json/list`, `/json/version`) and WebSocket upgrades to this port.

**Why three ports instead of two?**  
If the child reused `APP_PORT`, it would conflict with the main process. If the inspector used `APP_PORT+1`, it would conflict with the child app. Separating them allows:
- Main app to stay on its original port
- Child app to run on a predictable adjacent port
- Inspector to stay on the standard `9229`

---

## Request Routing

### The Proxy Middleware

Registered by the module itself via `NestModule.configure()` →
`consumer.apply(InferDebugMiddleware).forRoutes('*')` — it runs before NestJS
routing on every request:

```typescript
use(req: Request, res: Response, next: NextFunction): void {
  // forRoutes('*') becomes an Express 5 wildcard mount that strips req.url
  // to '/' in here — originalUrl keeps the real path.
  const url = (req.originalUrl || req.url).split('?')[0];

  // Control endpoints and inspector discovery are served by the controller
  if (url === basePath || url.startsWith(`${basePath}/`) || url === '/json/version' || url === '/json/list') {
    return next();
  }

  // Matched routes go to child
  if (this.debugProxyService.shouldProxy(url)) {
    return this.debugProxyService.proxyToChild(req, res, url);
  }

  // Everything else stays in the main process
  next();
}
```

### Controller-Level Inspector Proxy (`infer-debug.controller.ts`)

The `/json/*` endpoints are handled by the controller, not the middleware, so they appear in Swagger (`docs-debug`) and can be tested manually:

```typescript
@Get('/json/list')
getJsonList(@Req() req: Request, @Res() res: Response): void {
  if (!this.debugProxyService.shouldProxy(req.url)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
  this.debugProxyService.proxyToInspector(req, res);
}
```

The `shouldProxy()` check ensures these endpoints only work when a debug session is active (`isChildReady = true`).

### URL Matching (`models/route-matcher.ts`, used by `InferDebugService.shouldProxy`)

Routes are stored as swagger-style templates:

```
/api/orders
/api/orders/{id}/cancel
/api/reports/{*}
```

Matching converts `{param}` to `[^/]+` and a `/{*}` suffix to an optional subtree
(`(?:/.*)?`), after escaping all other regex metacharacters:

```typescript
export function matchRouteTemplate(template: string, actual: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withSubtreeWildcard = escaped.replace(/\/\\\{\\\*\\\}/g, '(?:/.*)?');
  const parameterized = withSubtreeWildcard.replace(/\\\{[^}]+\\\}/g, '[^/]+');
  const regex = new RegExp('^' + parameterized + '$');
  return regex.test(actual);
}
```

**All HTTP methods** for a matched path go to the child. The child receives the full request (method, headers, body) and handles it normally.

---

## Header Forwarding Between Proxies

When a request travels from the client through multiple proxies, headers must be carefully managed.

### Chain: Client → Ingress → Main Process → Child Process

```
Client (curl, browser, etc.)
  │
  ▼  HTTPS, Host: api.example.com
Ingress (k8s)
  │
  ▼  HTTP, Host: api.example.com
Main Process (port 80)
  │
  ▼  HTTP, Host: 127.0.0.1:APP_PORT+1
Child Process (port APP_PORT+1)
```

### What Headers Are Forwarded

**Main → Child (`proxyHttp` in `infer-debug.service.ts`):**

```typescript
const proxyHeaders = headers ? { ...headers } : { ...req.headers };
```

The main process forwards **all original request headers** to the child, with one modification: if the request has a parsed body (`req.body !== undefined`), the `content-length` header is removed and recalculated from the serialized body.

**Why preserve all headers?**
The child process is the same application — the request must look to it exactly as
it looked to the main process, or the debugging session lies to you. That means
forwarding everything, in particular:
- `Authorization` and any session cookies — the child's auth guards must accept the request
- `x-request-id` — request tracing stays correlated across the proxy hop
- `x-b3-traceid`, `x-b3-spanid` — OpenTelemetry trace context
- `Content-Type`, `Accept` — content negotiation
- whatever custom headers your own gateway/infrastructure injects

A natural extension of this is **header-based routing control**: since the proxy
sees every header before deciding, requests could be routed to the child based on
header values (e.g. only your own test marker header), not just on the path. Not
implemented — open an issue if that would help your workflow.

**Why not set `Host: 127.0.0.1:APP_PORT+1`?**  
The `Host` header is preserved from the original request. The child process doesn't care about the `Host` header for its own routing (NestJS routes by path, not virtual host), so no rewrite is needed.

### Inspector Discovery Headers

For `/json/list` and `/json/version`, the `Host` header **is rewritten** to `127.0.0.1:9229`:

```typescript
const headers = { ...req.headers, host: `127.0.0.1:${this.inspectorPort}` };
```

This is required because the Node.js inspector validates the `Host` header against its configured address.

### WebSocket Upgrade Headers

WebSocket upgrades use the same host rewrite:

```typescript
headers: { ...request.headers, host: `127.0.0.1:${this.inspectorPort}` }
```

The `Upgrade: websocket` and `Connection: Upgrade` headers are preserved from the client.

---

## WebSocket Inspector Tunnel

### Chrome DevTools Connection Flow

1. User opens `chrome://inspect` and clicks "inspect"
2. Chrome requests `ws://127.0.0.1:9229/<uuid>` (on user's laptop)
3. Local proxy (the `infer-debug` CLI) receives the WebSocket upgrade
4. Local proxy opens `wss://remote-host/<uuid>`
5. Remote Ingress receives the WebSocket upgrade on port 443
6. Main process receives it (via `upgrade` event on HTTP server)
7. Main process opens `ws://127.0.0.1:9229/<uuid>`
8. Inspector accepts the connection
9. Bidirectional data flow: Chrome ↔ Local Proxy ↔ Ingress ↔ Main Process ↔ Inspector

### WebSocket Proxy Implementation

```typescript
httpServer.on('upgrade', (request, socket, head) => {
  debugProxyService.handleUpgrade(request, socket, head);
});
```

The `handleUpgrade` method:
1. Checks `isChildReady` — destroys socket if false
2. Calls `touchActivity('handleUpgrade')` to prevent auto-stop
3. Opens an HTTP request to `127.0.0.1:9229` with the same URL path
4. On `upgrade` response (HTTP 101), writes the 101 response back to the client socket
5. Pipes sockets bidirectionally through `Transform` streams that call `touchActivity` on data

### Data Activity Tracking

```typescript
const trackIn = new Transform({
  transform: (chunk: Buffer, _enc, cb) => {
    this.touchActivity('wsDataFromInspector');
    cb(null, chunk);
  },
});
const trackOut = new Transform({
  transform: (chunk: Buffer, _enc, cb) => {
    this.touchActivity('wsDataFromClient');
    cb(null, chunk);
  },
});
proxySocket.pipe(trackIn).pipe(socket);
socket.pipe(trackOut).pipe(proxySocket);
```

Every WebSocket frame triggers `touchActivity`, keeping the session alive during active debugging.

---

## Kubernetes / ArgoCD Deployment

### Container Port Configuration

The pod exposes **one container port** (80 for HTTP, 443 for HTTPS via Ingress). The other two ports are internal:

```yaml
# Deployment spec (simplified)
containers:
  - name: my-app
    ports:
      - containerPort: 80
        name: http
    env:
      - name: INFER_DEBUG
        value: "true"   # Enable debug proxy module
      - name: APP_PORT
        value: "80"     # Main app binds here
```

### Port Accessibility

| Port | From Where | How |
|------|-----------|-----|
| 80/443 | Internet | Via Ingress + Service |
| 80+1 | Inside pod only | `127.0.0.1:APP_PORT+1` |
| 9229 | Inside pod only | `127.0.0.1:9229` |

**No additional Service or Ingress rules are needed.** The child and inspector are bound to `127.0.0.1` (loopback), which is only accessible inside the pod.

### Why This Is Safe

- **No external exposure** of the inspector port — an attacker cannot connect to `9229` from outside the cluster
- **No port conflicts** — `APP_PORT+1` is predictable and never collides with other services
- **No extra k8s resources** — no additional Services, NetworkPolicies, or port-forwards needed
- **Standard Dockerfile** — the same `CMD ["npm", "run", "start:prod"]` works for both debug and non-debug pods

### Resource Implications

When `INFER_DEBUG=true`:
- The pod runs **two Node.js processes** (main + child)
- Memory usage approximately **doubles** when child is active
- CPU usage increases only for debug traffic
- Auto-stop (3 min idle) releases child resources

---

## Orchestration CLI Flow

The `infer-debug` CLI (`bin/infer-debug.js`) is the laptop-side orchestration client. It manages the full lifecycle of a debug session from your laptop.

### Full Execution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. ARGUMENT PARSING                                                  │
│    - Extract host, local port, routes from CLI args                  │
│    - Host is required (first arg or INFER_DEBUG_HOST env)            │
│    - Scheme honored: http:// stays plain HTTP; bare remote → https   │
│    - Default local port: 9229                                        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. PRE-FLIGHT CHECK                                                  │
│    GET <basePath>/available                                          │
│    │                                                                 │
│    ├─ {"status":"ok"}              → proceed                        │
│    ├─ {"status":"no","reason":"debugger attached"}                   │
│    │                               → exit with clear error           │
│    ├─ {"status":"no","reason":"zombie present"}                      │
│    │                               → exit with clear error           │
│    └─ {"status":"no","reason":"already running"}                     │
│                                    → warn, skip start, connect       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. DISCOVERY (before start)                                          │
│    GET <basePath>/status                                             │
│    → prints current status                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. START PHASE (only if available returned "ok")                     │
│    POST <basePath>/start                                             │
│    │                                                                 │
│    ├─ Poll GET <basePath>/status every 10s                           │
│    ├─ Max 12 attempts (2 min timeout)                                │
│    ├─ Print each attempt                                             │
│    └─ Stop when "running" or error                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 5. POST-START DISCOVERY                                              │
│    GET /json/version                                                 │
│    GET /json/list                                                    │
│    → prints inspector info (now available because child is running)  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 6. LOGS                                                              │
│    GET <basePath>/logs?lines=3                                       │
│    → prints latest child output                                      │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 7. ROUTE CONFIGURATION                                               │
│    GET <basePath>/routes  → current routes                           │
│    Merge with CLI-provided routes                                    │
│    POST <basePath>/routes  → new merged list                         │
│    → prints updated routes                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 8. LOCAL PROXY STARTUP                                               │
│    http.createServer() on local port (default 9229)                  │
│    │                                                                 │
│    ├─ HTTP requests → forwarded to remote host:443                   │
│    │                                                                 │
│    ├─ WebSocket /debug → discover inspector UUID                     │
│    │   → fetch /json/list from remote                                │
│    │   → extract UUID                                                │
│    │   → open wss://remote/uuid                                      │
│    │                                                                 │
│    └─ Print connection info:                                         │
│       "Configure chrome://inspect with 127.0.0.1:9229"              │
│       "devtools://devtools/bundled/inspector.html?ws=..."           │
└─────────────────────────────────────────────────────────────────────┘
```

### Protocol Detection

```javascript
function isLocalhost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

// Explicit scheme in the host URL wins (http://staging.internal stays plain HTTP).
// Otherwise: localhost → http, remote → https:
const secure = explicitScheme ?? !isLocalhost(host);
```

HTTPS targets use `rejectUnauthorized: false` (dev-stand self-signed certs are tolerated). Plain-HTTP remote targets are supported — pass the full `http://` URL.

### Inspector Discovery Caching

The local proxy caches the inspector UUID for 30 seconds:

```javascript
let inspectorPath = null;
let lastFetch = 0;
const FETCH_INTERVAL = 30000;

async function discoverInspector() {
  if (inspectorPath && now - lastFetch < FETCH_INTERVAL) {
    return inspectorPath;  // Use cached
  }
  // Fetch /json/list, parse UUID
  inspectorPath = `/${list[0].id}`;
  lastFetch = now;
}
```

On WebSocket 404, the cache is cleared and rediscovery happens on the next connection attempt.

---

## Debugger Session Detection

The system tracks whether Chrome DevTools is currently connected by parsing child process logs.

### Log Patterns

| Message | Meaning |
|---------|---------|
| `Debugger attached.` | Chrome DevTools connected to inspector |
| `Debugger ending on ws://127.0.0.1:9229/<uuid>` | Chrome DevTools disconnected |

### Detection Algorithm

```typescript
hasActiveDebugger(): boolean {
  const logs = this.logBuffer.getAll();
  let attached = 0;
  let ended = 0;
  for (const line of logs) {
    if (line.includes('Debugger attached.')) attached++;
    if (line.includes('Debugger ending on ws://')) ended++;
  }
  return attached > ended;
}
```

This is a **count-based approach**: if there are more "attached" messages than "ending" messages in the log buffer, a debugger session is active.

### Why This Approach

- **No inspector API** — Node.js does not expose a programmatic way to check inspector connection state
- **No WebSocket introspection** — we could track at the proxy level, but log parsing is simpler and handles reconnections
- **Log buffer is bounded** — CircularBuffer(1000) means old logs rotate out; this is intentional (handles long uptimes)
- **False positives are safe** — if we incorrectly report "attached", the CLI will show a clear error rather than silently failing

---

## Auto-Stop and Activity Tracking

### Activity Sources

The `touchActivity(source)` method is called from:

| Source | When |
|--------|------|
| `startChild` | Child process starts successfully |
| `proxyToChild` | HTTP request matches a debug route |
| `proxyToInspector` | Inspector discovery request |
| `handleUpgrade` | WebSocket upgrade initiates |
| `wsDataFromInspector` | Data flows from inspector to client |
| `wsDataFromClient` | Data flows from client to inspector |
| `childLog` | Child process writes to stdout/stderr |
| `controller/*` | Any infer-debug controller endpoint is hit |

### Auto-Stop Logic

```typescript
private readonly IDLE_TIMEOUT_MS = 3 * 60 * 1000;      // 3 minutes
private readonly IDLE_CHECK_INTERVAL_MS = 10 * 1000;   // 10 seconds

setInterval(() => {
  if (this.status !== 'running') return;
  const idleTime = Date.now() - this.lastActivityAt;
  if (idleTime >= this.IDLE_TIMEOUT_MS) {
    this.logger.log(`[InferDebug] Idle for ${t1}s of ${t2}s, auto-stopping child`);
    void this.autoStopWithZombieCheck();
  } else {
    this.logger.log(`[InferDebug] Activity present: idle for ${t1}s of ${t2}s (last: ${this.lastActivitySource})`);
  }
}, this.IDLE_CHECK_INTERVAL_MS);
```

### Zombie Check After Stop

```typescript
private async autoStopWithZombieCheck(): Promise<void> {
  const pid = this.child?.pid;
  this.stopChild();  // SIGTERM
  await new Promise((r) => setTimeout(r, 10000));  // Wait 10s
  if (pid && this.isProcessAlive(pid)) {
    this.logger.error(`[InferDebug] Zombie present: child process ${pid} still alive after stop`);
  } else {
    this.logger.log('[InferDebug] No zombie made: child process terminated cleanly');
  }
  this.status = 'stopped';
}
```

A "zombie" is specifically: **status = `stopped` but PID is still alive**. Running processes are never zombies, even if their PID is active.

---

## Key Design Decisions

### 1. Main Process Front-Facing (Not Wrap Proxy)

**Alternative shipped:** `bin/infer-debug-wrap.js` is included in the package — a standalone Node.js script that spawns the app and proxies everything, no NestJS integration needed.

**Why in-process is the default:**
- OpenTelemetry headers are injected by the Ingress/envoy layer **before** the request reaches the app
- A wrap proxy would need to re-inject these headers (complex, error-prone)
- The in-process approach preserves all incoming headers naturally
- No separate entry point (your normal bootstrap handles both modes)

**When to use the wrap proxy instead:** when you cannot or do not want to touch the app's module wiring at all — e.g. debugging an app you do not own the source of, or a non-NestJS Node.js service.

### 2. Path-Only Route Matching (Not Method-Specific)

**Why:** When you set a breakpoint in a controller method, you want ALL requests to that path to hit it — GET, POST, PUT, DELETE. The child handles methods normally. This is simpler and matches developer intuition.

**Open question:** method-specific matching (`GET /api/orders` proxied, `POST /api/orders` not) is doable but adds config surface. Worth discussion — open an issue if you need it.

### 3. Express Middleware Over NestJS Interceptor

**Why:** Interceptors run after NestJS routing. We need to intercept requests **before** routing to decide whether to proxy. Express middleware runs at the framework level, before any controllers.

**Limitation:** only the Express adapter is supported today; there is no Fastify adapter yet. If you run Fastify, open an issue — the proxy logic itself is adapter-agnostic and a Fastify hook equivalent is feasible.

### 4. `127.0.0.1` Over `localhost` for Inspector

**Why:** Chrome DevTools CSP (Content Security Policy) allows `ws://127.0.0.1:*` but may block `ws://localhost:*` in some configurations. Using the IP address is more reliable. Feel free to make as many hops as needed — the tunnel does not care about the final hostname.

### 5. Log Buffer for Session Detection

**Why:** Instead of maintaining connection state manually (which gets complex with reconnections, dropped connections, etc.), we parse logs. Logs are already collected for display, so this adds zero overhead.

### 6. Single Shared Environment

**Why:** The child process uses `env: { ...process.env, APP_PORT: String(this.childPort) }`. This means:
- Same database credentials
- Same feature flags
- Same Kafka config
- Only `APP_PORT` differs

No environment drift between main and child.

### 7. Auto-Stop Instead of Manual Cleanup

**Why:** Developers forget to stop debug sessions. An idle child consumes ~50% extra memory. Auto-stop (3 min) with clear logging ensures resources are freed. The check interval (10s) is frequent enough to catch idle sessions quickly but not so frequent that it generates noise.

### 8. `INFER_DEBUG` Environment Variable

**Why:** A single env var controls the entire feature:
- `true` → middleware registered, child can be spawned, endpoints available
- `false` or unset → zero overhead, no middleware, no endpoints

This allows the same Docker image to be used for both debug and production pods. Only the Deployment manifest changes.

---

## Troubleshooting

### "Cannot start: HTTP 400" or "HTTP 404"

**Cause:** The CLI is using `http:` instead of `https:` for a remote host.

**Check:** In `bin/infer-debug.js`, `tryRequest()` should pass `'https:'` (with colon) to `requestJson()`, which checks `protocol === 'https:'`.

### "Cannot start: debugger attached"

**Cause:** Another Chrome DevTools window is connected to the same inspector session.

**Fix:** Close the existing DevTools tab/window. The session detection looks for `Debugger ending on ws://` in logs; if you closed DevTools uncleanly, wait 10 seconds and retry.

### "Cannot start: zombie present"

**Cause:** A previous child process refused to die after `SIGTERM`.

**Fix:** SSH into the pod and `kill -9 <pid>`, or restart the pod.

### Inspector endpoints return 404

**Cause:** Child process is not running or not ready.

**Check:**
```bash
curl https://host/infer-debug/status
# Should return: running: no zombie: debugger detached

# If "stopped", start it:
curl -X POST https://host/infer-debug/start
```

### WebSocket connection fails

**Cause:** Ingress does not support WebSocket upgrades, or the `upgrade` event is not reaching the main process.

**Check:** Ingress must have `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"` and support WebSocket (`Connection: Upgrade`, `Upgrade: websocket` headers).

### Breakpoints not hitting

**Cause:** The route is not in the registry.

**Check:**
```bash
curl https://host/infer-debug/routes
# Should include your path

# Add it if missing:
curl -X POST https://host/infer-debug/routes \
  -H "Content-Type: text/plain" \
  -d "/v1/your/endpoint"
```

### Child logs not visible

**Cause:** Log buffer may have been cleared or not yet populated.

**Check:**
```bash
curl "https://host/infer-debug/logs?lines=50"
```

If empty, the child may not have produced output yet, or the buffer was cleared via `DELETE /infer-debug/logs`.

### "Activity present" logs every 10 seconds even when idle

**Cause:** Something is polling the debug endpoints (health check, swagger UI auto-refresh, etc.).

**Check:** Look at the `last: <source>` in the activity log. If it says `controller/status`, something is calling `/infer-debug/status`. This is normal for some monitoring tools.

---

## File Reference (package)

| File | Purpose |
|------|---------|
| `src/infer-debug.module.ts` | Dynamic module (`forRoot`/`forRootAsync`); self-registers the middleware |
| `src/infer-debug.module-definition.ts` | `ConfigurableModuleBuilder` wiring, `INFER_DEBUG_OPTIONS` token |
| `src/infer-debug.service.ts` | Core service: child spawn, port discovery, proxy logic, session detection |
| `src/infer-debug.controller.ts` | REST API for control endpoints |
| `src/infer-debug.middleware.ts` | The real proxy path (reads `originalUrl` — see change #3 above) |
| `src/infer-debug.options.ts` | `TInferDebugOptions`, defaults resolver, `resolveChildEntry()` |
| `src/swagger.ts` | `setupInferDebugDocs()` + `stripInferDebugPaths()` |
| `src/models/circular-buffer.ts` | Log buffer implementation |
| `src/models/route-matcher.ts` | Route template matching (`{param}`, `/{*}`) |
| `bin/infer-debug.js` | Orchestration CLI (host required) |
| `test/*.spec.ts` | Unit tests (buffer, matcher, options) |
