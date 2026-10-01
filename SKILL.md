# SKILL: infer-debug

Use this when asked to debug a running Node.js application — NestJS, Express,
Fastify, or raw `http.Server` — with real breakpoints, without restarting the
main process under `--inspect`. The package spawns a second copy of the app
with the inspector enabled and proxies only the requests you mark; all other
traffic is untouched.

## When to reach for this

- "Hit a breakpoint in controller X on the dev/staging pod."
- "This bug only reproduces with real traffic / real headers."
- "We can't restart the main app with `--inspect` (downtime, prod-like env)."

Do NOT use it for: unit-test debugging (just use `--inspect` locally) or as an
APM/monitoring tool.

## Integrate (host app side)

Same `TInferDebugOptions` object everywhere; pick your stack:

```typescript
// NestJS (app.module.ts)
import { InferDebugModule } from 'infer-debug/nestjs';

@Module({
  imports: [InferDebugModule.forRoot({
    healthcheckPath: '/healthcheck',                    // optional, speeds readiness
    childReadyStdoutPattern: /listening on port/i,      // optional
  })],
})
export class AppModule {}
```

```javascript
// Express — middleware before your routes, attachServer once listening
const { InferDebugCore } = require('infer-debug');
const { createInferDebugMiddleware } = require('infer-debug/express');
const core = new InferDebugCore({ childPortEnvVar: 'PORT' });
app.use(createInferDebugMiddleware(core));
const server = app.listen(3000, () => core.attachServer(server));
```

```javascript
// Fastify — one plugin does it all (hooks onRequest/onReady/onClose)
const { inferDebugFastifyPlugin } = require('infer-debug/fastify');
fastify.register(inferDebugFastifyPlugin, { childPortEnvVar: 'PORT' });
// core reachable as fastify.inferDebug
```

```javascript
// Raw http.Server — no framework at all
const core = new InferDebugCore({ childPortEnvVar: 'APP_PORT' });
const server = http.createServer((req, res) => {
  if (core.handleHttp(req, res)) return;  // control API, /json/*, marked
  // ... your app ...
});
server.listen(3000, () => core.attachServer(server));
```

Runnable versions of all four live under `examples/` (incl. a one-container-
per-adapter docker-compose: `npm run compose:examples`).

Another framework (Koa, Hono, a custom router)? The core is framework-free —
an adapter is a four-call contract (`new InferDebugCore` → first-refusal
`handleHttp`/`shouldHandle` pre-routing → `attachServer` → `close`), see
README "Writing your own adapter".

Zero-config works too: `InferDebugModule.forRoot()` + `INFER_DEBUG=true` env.
Then rebuild the host and boot it with the env var set.

Options (all optional): `enabled`, `enabledEnvVar` ('INFER_DEBUG'),
`basePath` ('/infer-debug'), `childPort` (default: app port + 1),
`inspectorPort` (9229), `idleTimeoutMs` (3 min), `logBufferSize` (1000),
`childEntry` (default `process.argv[1]`; use `resolveChildEntry('dist/...')` to
pin another entrypoint), `childPortEnvVar` ('APP_PORT'),
`childReadyStdoutPattern`, `healthcheckPath`.

## Run a session (operator side)

```bash
# from the host app's node_modules/.bin, or npx infer-debug
infer-debug <host> [localPort]
# one command = the whole session: available-check, start, local proxy on 9229
# then point chrome://inspect at 127.0.0.1:9229

infer-debug --help    # full usage
```

Control endpoints are plain HTTP on the app port: `GET <basePath>/status`,
`POST <basePath>/stop`, `GET <basePath>/logs?lines=N`.

`<host>` accepts `host:port`, `http://host:port`, or a bare host (https for
remote, http for localhost). Then open `chrome://inspect`, add the host's
`<debugPort>` (tunnel: `ssh -L 9229:127.0.0.1:9229 <pod-host>` if remote),
send a request carrying the trigger header (default `infer-debug: 1`), and
the child pauses on your breakpoint. Selecting WHICH URLs get marked is
app-side — see `examples/nest-route-table` for the header-per-route recipe.

Verify availability first: `GET <basePath>/available` → `{"status":"ok"}`.
Swagger for the control API lives at `infer-debug/docs` (never pollutes the
host app's own swagger — see `setupInferDebugDocs` / `stripInferDebugPaths`).

## AI agents: drive the session yourself (CDP, no Chrome)

If you are an agent working on a running app: this package turns "ask the
user to reproduce and paste state" into "attach and look". The CLI above is a
Chrome bridge for humans — **you** don't need it (plain HTTP + one WebSocket
on the app's own port is enough for you), but don't dismiss it: for a human
watching a pod behind a k8s 80/443 ingress, that local proxy is the *only*
path into Chrome DevTools. The two of you can share one session: you drive
CDP through the app port, they watch the same child through the CLI proxy or
the `devtools://` jump link.

**Consent first — the human keeps the controls.** Starting a session spawns a
full child copy of the app (visible, memory-bearing, ~3-min idle auto-stop as
the safety net). **Ask the user before starting one** — unless you are
running in yolo/auto-approve mode, where proceeding is the point of the mode.
While you work, they can watch live in Chrome, read `GET <basePath>/logs`,
and `POST <basePath>/stop` overrides anything you are doing at any time. You
get the attachment; they keep the kill switch.

1. `GET <basePath>/available` → require `{"status":"ok"}`. If `disabled`,
   tell the user to boot with `INFER_DEBUG=true`; do not work around it.
2. `POST <basePath>/start`, then poll `GET <basePath>/status` until
   `running` (a flip back to `stopped` means the child died on boot —
   read `GET <basePath>/logs` for why).
3. Fire the request you care about with the trigger header:
   `curl -H 'infer-debug: 1' <app-url>` — it runs **in the child**; the
   response header carries a `devtools://` deep link — hand it to the human
   so they can watch the same child in Chrome while you drive CDP.
4. `GET /json/list` (fixed path, not under basePath) → take `id` of the
   target, open `ws://<app-host>:<app-port>/<id>` — the inspector WS is
   tunnelled through the app port, uuid-shaped path, no headers needed.
   (Any OTHER WebSocket upgrade carrying the trigger header is relayed
   wholesale to the child through the app port — same port, no tunnel
   path — so an agent can reach the child's own WebSocket endpoints, e.g.
   strategy's `/strategy`, from outside; `503` while the child is down.)
5. Speak CDP. Minimal client (Node ≥ 22, global WebSocket):

   ```javascript
   const ws = new WebSocket(`ws://${appHost}:${appPort}/${targetId}`);
   ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate',
     params: { expression: 'process.pid', returnByValue: true } }));
   ws.onmessage = (ev) => {
     const m = JSON.parse(String(ev.data));
     if (m.id === 1) { console.log(m.result.result.value); ws.close(); }
   };
   ```

   Breakpoints work the same way: `Debugger.enable` →
   `Debugger.setBreakpointByUrl` → re-fire the marked request →
   `Debugger.paused` event → inspect `callFrames` / `Runtime.evaluate` →
   `Debugger.resume`. A complete breakpoint round-trip lives in
   `e2e/cdp-client.ts` + `e2e/infer-debug.e2e.spec.ts`.
6. Done: `POST <basePath>/stop`, or just walk away — idle auto-stop (3 min
   default) cleans the child up. **Caveat:** keep your CDP traffic on the
   tunnelled app-port path; a WS attached directly to the inspector port
   (9229) does not reset the idle timer and the session can be stopped
   underneath you.

**Then hand the human their half — every time.** A session nobody connects
to is a wasted session, and the human will not discover the steps on their
own. When you start a session, end your reply with the how-to: numbered,
short, with the real values already filled in. Template — adapt, don't
paste raw:

```text
Debug session running — the child copy of <app> answers marked requests
through port <appPort>. To watch it in Chrome:
  1. Run and leave running:  npx infer-debug http://<host>:<appPort>
     (it prints "Listening on http://127.0.0.1:9229")
  2. Open chrome://inspect → Configure → add 127.0.0.1:9229 → inspect.
     Editor instead of Chrome: VS Code "Attach to Node Process" also finds
     127.0.0.1:9229.
  3. Set your breakpoint, then tell me — I'll fire the marked request.
  No-CLI alternative: paste this into Chrome:
     devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=<host>:<appPort>/<targetId>
  Stop anytime:  curl -X POST http://<host>:<appPort>/infer-debug/stop
  (or say the word and I'll stop it; idle auto-stop closes it in ~3 min anyway)
```

Rules for you, the agent: fill in real values (host, port, targetId) —
placeholders are how the human gets lost; always offer both the Chrome and
the editor path; always mention how to stop. Repeat the how-to whenever the
session restarts — the targetId changes with every child.

What you get that logs never give: live heap values, paused call frames,
conditional breakpoints on *this* request only — while the main process keeps
serving everyone else.

## Pitfalls (check these first when it misbehaves)

1. **Request not proxied** → it must carry the trigger header (presence is
   enough, any value). If the app uses a route table to set the header per
   URL (`examples/nest-route-table`), verify the header is actually set for
   that path.
2. **Middleware sees `/`** → it reads `req.originalUrl`; if you fork the code,
   never switch to `req.url` (Express 5 wildcard mount strips it).
3. **`No provider for...` / double instantiation under `file:` linking** →
   duplicate `@nestjs/*` copies. The package must resolve the host's @nestjs
   (symlink rule, see AGENTS.md).
4. **Child never ready** → set `childReadyStdoutPattern`/`healthcheckPath`, or
   read `<basePath>/logs` for the child's boot error (it shares the parent env:
   same DB, same secrets — those must actually work).
5. **Session died mid-debug** → idle auto-stop (default 3 min). Activity resets
   it; long pauses on a breakpoint do not count as activity between requests.
6. **`/json/version` 404** → those paths are fixed by the DevTools protocol and
   are NOT under `basePath`; do not "fix" clients probing them.

## Developing the package itself

Read `AGENTS.md` in the package root — invariants there (controller factory,
originalUrl, Symbol token, manual DynamicModule) are easy to break by
"cleanup". Build + test: `npm run build && npm test`.
