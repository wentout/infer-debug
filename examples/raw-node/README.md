# Raw Node.js (no framework)

`server.js` shows the minimal wiring: construct `InferDebugCore`, give it first
refusal on every request via `handleHttp`, and call `attachServer(server)` once
listening (port discovery + inspector WS tunnel). `close()` on shutdown.

```bash
INFER_DEBUG=true node examples/raw-node/server.js

curl -X POST localhost:3000/infer-debug/start      # spawn the debug child
curl -H 'infer-debug: 1' localhost:3000/api/orders/42
# → answered by the CHILD (different pid), response carries:
#   infer-debug: devtools://devtools/bundled/js_app.html?...&ws=localhost:3000/<targetId>
curl localhost:3000/api/orders/42                  # unmarked → main process
curl -X POST localhost:3000/infer-debug/stop
```

`handleHttp` returns `true` only when it actually answered (control API,
`/json/*` discovery, or a marked request) — everything else is yours.
