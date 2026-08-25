import { createStartupSingleFlight } from './startup-single-flight.mjs';

const loadServerDependencies = () => import('@openchamber/web/server/preload-server-dependencies.js');

const captureEnvironmentAccesses = async (load, options) => {
  const { capturePreloadEnvironmentAccesses } = await import('@openchamber/web/server/preload-env-guard.js');
  return capturePreloadEnvironmentAccesses(load, options);
};

export class ServerDependencyPreloadEnvironmentError extends Error {
  constructor(accesses) {
    const first = accesses[0];
    super(`Server dependency preload accessed process.env before the login-shell environment was applied${first ? ` (${first.operation} ${first.key} at ${first.frame})` : ''}`);
    this.name = 'ServerDependencyPreloadEnvironmentError';
    this.code = 'OPENCHAMBER_SERVER_PRELOAD_ENV_ACCESS';
    this.accesses = accesses;
  }
}

export const createServerDependencyPreload = ({
  load = loadServerDependencies,
  capture = captureEnvironmentAccesses,
  isEnvironmentReady = () => false,
  waitForEnvironmentReady,
  logger = console,
  now = () => performance.now(),
  recordPerformance = () => {},
} = {}) => {
  const start = createStartupSingleFlight(async () => {
    const startedAt = now();
    recordPerformance('electron.server-preload.start');
    try {
      let accesses = [];
      if (isEnvironmentReady()) {
        await load();
      } else {
        const captureOptions = { shouldCapture: () => !isEnvironmentReady() };
        if (waitForEnvironmentReady) captureOptions.settle = waitForEnvironmentReady;
        const result = await capture(load, captureOptions);
        accesses = result.accesses;
      }
      if (accesses.length > 0) throw new ServerDependencyPreloadEnvironmentError(accesses);
      recordPerformance('electron.server-preload.ready', { durationMs: now() - startedAt });
      return { ok: true };
    } catch (error) {
      logger.error('[electron] server dependency preload failed', {
        error: error instanceof Error ? error.message : String(error),
        accesses: Array.isArray(error?.accesses) ? error.accesses : [],
      });
      return { ok: false, error };
    }
  });

  return {
    begin: start,
    wait: async () => {
      const result = await start();
      if (!result.ok) throw result.error;
    },
  };
};
