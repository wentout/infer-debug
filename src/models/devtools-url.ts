/**
 * Builds the Chrome DevTools deep link that attaches to the debug child's
 * inspector target THROUGH the host app's own HTTP port: infer-debug tunnels
 * the inspector WebSocket at the same path, so `ws=<app-host>/<targetId>`
 * reaches the child without any port forwarding, SSH hop, or CLI bridge.
 */
export function buildDevtoolsJumpUrl(host: string, targetId: string): string {
  return `devtools://devtools/bundled/js_app.html?experiments=true&v8only=true&ws=${host}/${targetId}`;
}
