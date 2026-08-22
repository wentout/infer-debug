import { normalizeBasePath, resolveInferDebugOptions } from '../src/infer-debug.options';

describe('resolveInferDebugOptions', () => {
  const ENV = process.env;

  afterEach(() => {
    process.env = ENV;
  });

  it('applies defaults when no options are given', () => {
    process.env = { ...ENV, INFER_DEBUG: 'true' };
    const resolved = resolveInferDebugOptions();
    expect(resolved).toEqual({
      enabled: true,
      inspectorPort: 9229,
      idleTimeoutMs: 180000,
      idleCheckIntervalMs: 10000,
      logBufferSize: 1000,
      childEntry: process.argv[1],
      childPortEnvVar: 'APP_PORT',
      basePath: '/infer-debug',
      childReadyStdoutPattern: undefined,
      healthcheckPath: undefined,
      childPort: undefined,
    });
  });

  it('respects explicit enabled over the env var', () => {
    process.env = { ...ENV, INFER_DEBUG: 'true' };
    expect(resolveInferDebugOptions({ enabled: false }).enabled).toBe(false);
    process.env = { ...ENV, INFER_DEBUG: 'false' };
    expect(resolveInferDebugOptions({ enabled: true }).enabled).toBe(true);
  });

  it('reads enabled from a custom env var when enabledEnvVar is set', () => {
    process.env = { ...ENV, MY_DEBUG_FLAG: 'true' };
    delete process.env.INFER_DEBUG;
    expect(resolveInferDebugOptions({ enabledEnvVar: 'MY_DEBUG_FLAG' }).enabled).toBe(true);
    expect(resolveInferDebugOptions({ enabledEnvVar: 'OTHER_FLAG' }).enabled).toBe(false);
  });

  it('passes through custom values', () => {
    const pattern = /listening/i;
    const resolved = resolveInferDebugOptions({
      inspectorPort: 9230,
      idleTimeoutMs: 1000,
      childEntry: '/app/dist/custom-main.js',
      childPortEnvVar: 'PORT',
      childReadyStdoutPattern: pattern,
      healthcheckPath: '/healthcheck',
      childPort: 4100,
      basePath: '/dbg',
    });
    expect(resolved.inspectorPort).toBe(9230);
    expect(resolved.idleTimeoutMs).toBe(1000);
    expect(resolved.childEntry).toBe('/app/dist/custom-main.js');
    expect(resolved.childPortEnvVar).toBe('PORT');
    expect(resolved.childReadyStdoutPattern).toBe(pattern);
    expect(resolved.healthcheckPath).toBe('/healthcheck');
    expect(resolved.childPort).toBe(4100);
    expect(resolved.basePath).toBe('/dbg');
  });
});

describe('normalizeBasePath', () => {
  it('defaults to /infer-debug', () => {
    expect(normalizeBasePath()).toBe('/infer-debug');
  });

  it('adds a missing leading slash and strips a trailing one', () => {
    expect(normalizeBasePath('dbg')).toBe('/dbg');
    expect(normalizeBasePath('/dbg/')).toBe('/dbg');
    expect(normalizeBasePath('tools/debug/')).toBe('/tools/debug');
  });

  it('keeps the root path intact', () => {
    expect(normalizeBasePath('/')).toBe('/');
  });
});
