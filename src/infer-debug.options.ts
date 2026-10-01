import { resolve } from 'path';

/**
 * Configuration for the debug proxy module.
 * Every field is optional — sensible defaults make `InferDebugModule.forRoot()` zero-config.
 */
export type TInferDebugOptions = {
  /**
   * Master switch. When false, the module registers no proxying behavior, no upgrade
   * hook, and the control endpoints report `{ status: 'no', reason: 'disabled' }`.
   * Default: the env var named by {@link TInferDebugOptions.enabledEnvVar}
   * ('INFER_DEBUG' unless overridden) being `'true'`.
   */
  enabled?: boolean;

  /**
   * Node.js inspector port of the debug child. Loopback only.
   * Default: 9229.
   */
  inspectorPort?: number;

  /**
   * Idle time after which the debug child is auto-stopped.
   * Default: 3 * 60 * 1000 (3 minutes).
   */
  idleTimeoutMs?: number;

  /**
   * How often the idle check runs.
   * Default: 10 * 1000 (10 seconds).
   */
  idleCheckIntervalMs?: number;

  /**
   * Maximum number of child stdout/stderr lines kept for `/infer-debug/logs`
   * and debugger-session detection.
   * Default: 1000.
   */
  logBufferSize?: number;

  /**
   * Entry file spawned as the debug child.
   * Default: `process.argv[1]` — the file the host app itself was launched with
   * (e.g. `dist/src/main` under `npm run start:prod`).
   * Override for dev setups (ts-node etc.) or to debug a different entrypoint.
   * See {@link resolveChildEntry}.
   */
  childEntry?: string;

  /**
   * Env var name used to pass the child its HTTP port.
   * Default: 'APP_PORT'.
   */
  childPortEnvVar?: string;

  /**
   * When set, child startup waits until the child's stdout matches this pattern
   * before probing readiness. When unset, stdout waiting is skipped and only the
   * readiness probe is used.
   * Example: /Server listening on port/i
   */
  childReadyStdoutPattern?: RegExp;

  /**
   * When set, the child is considered ready when a GET to this path on the child
   * port returns any status < 500 (e.g. '/healthcheck').
   * When unset, a plain TCP connect to the child port is used instead — works for
   * any NestJS app without a dedicated health route.
   */
  healthcheckPath?: string;

  /**
   * Name of the environment variable consulted for the default of {@link enabled}.
   * This is only a convention — you can always set `enabled` explicitly from your
   * own config system and ignore the env var entirely.
   * Default: 'INFER_DEBUG'.
   */
  enabledEnvVar?: string;

  /**
   * Name of the HTTP header that marks a request for the debug child.
   * Any request carrying it is proxied to the child (when one is running);
   * the proxied response carries the same header with a Chrome DevTools deep
   * link that attaches to the child's inspector THROUGH the app's own port.
   * The header is consumed by the proxy layer — it is NOT forwarded to the child.
   * Default: 'infer-debug'.
   */
  headerName?: string;

  /**
   * URL prefix of the control API (`/status`, `/start`, `/stop`,
   * `/logs`, `/available` live under it).
   * Default: '/infer-debug'.
   */
  basePath?: string;

  /**
   * Exact HTTP port for the debug child. When unset, the port is auto-discovered:
   * the app's bound port (from the server's `listening` event) + 1.
   */
  childPort?: number;

  /**
   * WebSocket upgrade paths that FOLLOW THE MARK: a marked upgrade whose path
   * is listed here is relayed wholesale to the secondary process (which owns
   * the path — e.g. a mounted strategy channel). Marked upgrades on any other
   * path, and all unmarked upgrades, are handed to `appUpgradeHandler`.
   * Default: [] — no relaying; with the default the upgrade hook behaves
   * exactly as before for every existing user.
   */
  wsRelay?: string[];

  /**
   * The app's own WebSocket upgrade handling. infer-debug is the single
   * upgrade decision point on the server: it relays what the routing table
   * sends to the secondary (inspector path; marked wsRelay paths) and calls
   * this handler for EVERY upgrade it does not relay. When unset, non-relayed
   * upgrades are left to other listeners, as before.
   */
  appUpgradeHandler?: TUpgradeHandler;
};

export type TUpgradeHandler = (
  request: import('http').IncomingMessage,
  socket: import('stream').Duplex,
  head: Buffer,
) => void;

export type TResolvedInferDebugOptions = Required<
  Pick<
    TInferDebugOptions,
    'enabled' | 'inspectorPort' | 'idleTimeoutMs' | 'idleCheckIntervalMs' | 'logBufferSize' | 'childEntry' | 'childPortEnvVar' | 'basePath' | 'headerName'
  >
> &
  Pick<TInferDebugOptions, 'childReadyStdoutPattern' | 'healthcheckPath' | 'childPort' | 'appUpgradeHandler'> & {
    wsRelay: string[];
  };

export const DEFAULT_BASE_PATH = '/infer-debug';
export const DEFAULT_HEADER_NAME = 'infer-debug';

export function normalizeBasePath(basePath: string = DEFAULT_BASE_PATH): string {
  const withLeading = basePath.startsWith('/') ? basePath : `/${basePath}`;
  return withLeading.endsWith('/') && withLeading.length > 1 ? withLeading.slice(0, -1) : withLeading;
}

export function resolveInferDebugOptions(options: TInferDebugOptions = {}): TResolvedInferDebugOptions {
  const resolved: TResolvedInferDebugOptions = {
    enabled: options.enabled ?? process.env[options.enabledEnvVar ?? 'INFER_DEBUG'] === 'true',
    inspectorPort: options.inspectorPort ?? 9229,
    idleTimeoutMs: options.idleTimeoutMs ?? 3 * 60 * 1000,
    idleCheckIntervalMs: options.idleCheckIntervalMs ?? 10 * 1000,
    logBufferSize: options.logBufferSize ?? 1000,
    childEntry: options.childEntry ?? process.argv[1],
    childPortEnvVar: options.childPortEnvVar ?? 'APP_PORT',
    basePath: normalizeBasePath(options.basePath),
    // Node lowercases incoming header names — normalize so lookups never miss.
    headerName: (options.headerName ?? DEFAULT_HEADER_NAME).toLowerCase(),
    childReadyStdoutPattern: options.childReadyStdoutPattern,
    healthcheckPath: options.healthcheckPath,
    childPort: options.childPort,
    wsRelay: options.wsRelay ?? [],
  };
  // only present when set — keeps the resolved object free of undefined keys
  if (options.appUpgradeHandler !== undefined) {
    resolved.appUpgradeHandler = options.appUpgradeHandler;
  }
  return resolved;
}

/**
 * Helper for the "utilise other entrypoint" case: resolves a project-relative
 * path (against the process working directory) into an absolute path suitable
 * for {@link TInferDebugOptions.childEntry}.
 *
 * Example: `childEntry: resolveChildEntry('dist/worker/main.js')`
 */
export function resolveChildEntry(relativePath: string): string {
  return resolve(process.cwd(), relativePath);
}
