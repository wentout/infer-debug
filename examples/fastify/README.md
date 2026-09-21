# Fastify

`server.js` shows the wiring: `fastify.register(inferDebugFastifyPlugin, options)`
is all of it. The plugin's `onRequest` hook answers the control API, `/json/*`
discovery, and header-marked requests (via `reply.hijack()`, only for traffic
the core will definitively handle); the WS tunnel and port discovery attach in
its `onReady` hook; the child stops in `onClose`. The core instance is
reachable as `fastify.inferDebug` for programmatic control.

```bash
INFER_DEBUG=true node examples/fastify/server.js

curl -X POST localhost:3002/infer-debug/start      # spawn the debug child
curl -H 'infer-debug: 1' localhost:3002/api/orders/42
# → answered by the CHILD (different pid), response carries:
#   infer-debug: devtools://devtools/bundled/js_app.html?...&ws=localhost:3002/<targetId>
curl localhost:3002/api/orders/42                  # unmarked → main process
curl -X POST localhost:3002/infer-debug/stop
```

Run it containerized (publishes only the app port; child and inspector stay on
loopback inside): see [`examples/docker-compose.yaml`](../docker-compose.yaml).
