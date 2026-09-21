# NestJS

`src/` shows the wiring: one `InferDebugModule.forRoot()` import. The module
self-registers its pre-routing middleware (`forRoutes('*')`), the WS tunnel
and port discovery attach on application bootstrap, and the child stops on
module destroy.

```bash
npm run build && npm run build:examples     # package dist/ + example dist/
INFER_DEBUG=true node examples/nestjs/dist/main.js

curl -X POST localhost:3003/infer-debug/start      # spawn the debug child
curl -H 'infer-debug: 1' localhost:3003/api/orders/42
# → answered by the CHILD (different pid), response carries:
#   infer-debug: devtools://devtools/bundled/js_app.html?...&ws=localhost:3003/<targetId>
curl localhost:3003/api/orders/42                  # unmarked → main process
curl -X POST localhost:3003/infer-debug/stop
```

The example's `tsconfig.json` uses `moduleResolution: node16` so the source
imports `infer-debug/nestjs` exactly like an external consumer (Node resolves
the same name at runtime via the package's `exports`).

Run it containerized (publishes only the app port; child and inspector stay on
loopback inside): see [`examples/docker-compose.yaml`](../docker-compose.yaml).
