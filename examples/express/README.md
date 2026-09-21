# Express

`server.js` shows the wiring: construct `InferDebugCore`, mount
`createInferDebugMiddleware(core)` **before your routes** (it answers the
control API, `/json/*` discovery, and header-marked requests; everything else
falls through to your routes), and call `attachServer(server)` once listening
(port discovery + inspector WS tunnel). `close()` on shutdown.

```bash
INFER_DEBUG=true node examples/express/server.js

curl -X POST localhost:3001/infer-debug/start      # spawn the debug child
curl -H 'infer-debug: 1' localhost:3001/api/orders/42
# → answered by the CHILD (different pid), response carries:
#   infer-debug: devtools://devtools/bundled/js_app.html?...&ws=localhost:3001/<targetId>
curl localhost:3001/api/orders/42                  # unmarked → main process
curl -X POST localhost:3001/infer-debug/stop
```

Run it containerized (publishes only the app port; child and inspector stay on
loopback inside): see [`examples/docker-compose.yaml`](../docker-compose.yaml).
