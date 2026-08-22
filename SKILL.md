# SKILL: infer-debug

Use this when asked to debug a running NestJS (Express) application with real
breakpoints, without restarting the main process under `--inspect`. The package
spawns a second copy of the app with the inspector enabled and proxies only
selected routes to it; all other traffic is untouched.

## When to reach for this

- "Hit a breakpoint in controller X on the dev/staging pod."
- "This bug only reproduces with real traffic / real headers."
- "We can't restart the main app with `--inspect` (downtime, prod-like env)."

Do NOT use it for: unit-test debugging (just use `--inspect` locally), apps on
the Fastify adapter (unsupported today), or as an APM/monitoring tool.

## Integrate (host app side)

```typescript
// app.module.ts
import { InferDebugModule } from 'infer-debug';

@Module({
  imports: [InferDebugModule.forRoot({
    healthcheckPath: '/healthcheck',                    // optional, speeds readiness
    childReadyStdoutPattern: /listening on port/i,      // optional
  })],
})
export class AppModule {}
```

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
infer-debug <host> [localPort] '/api/orders/{id}' '/api/orders/{*}'
# one command = the whole session: available-check, start, routes, local proxy on 9229
# then point chrome://inspect at 127.0.0.1:9229

infer-debug --help    # full usage; every positional after host MUST start with '/'
```

There are NO subcommands (`status`, `stop`, ... are rejected as malformed routes).
Control endpoints are plain HTTP on the app port: `GET <basePath>/status`,
`POST <basePath>/stop`, `GET <basePath>/logs?lines=N`, `GET <basePath>/routes`.

`<host>` accepts `host:port`, `http://host:port`, or a bare host (https for
remote, http for localhost). Then open `chrome://inspect`, add the host's
`<debugPort>` (tunnel: `ssh -L 9229:127.0.0.1:9229 <pod-host>` if remote),
trigger a request to a proxied route, and the child pauses on your breakpoint.

Verify availability first: `GET <basePath>/available` → `{"status":"ok"}`.
Swagger for the control API lives at `infer-debug/docs` (never pollutes the
host app's own swagger — see `setupInferDebugDocs` / `stripInferDebugPaths`).

## Pitfalls (check these first when it misbehaves)

1. **Route not proxied** → template mismatch. Templates are swagger-style:
   `{param}` = one segment, `/{*}` = subtree. Path-only matching (all methods).
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
