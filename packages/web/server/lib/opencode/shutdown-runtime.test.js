import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    await vi.advanceTimersByTimeAsync(1000);

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reserves time after managed OpenCode shutdown for final fallback cleanup', async () => {
    const openCodeProcess = { close: vi.fn(async () => {}) };
    const deadline = Date.now() + 15000;
    const runtime = createRuntime(null, {
      shouldSkipOpenCodeStop: () => false,
      getOpenCodeProcess: () => openCodeProcess,
    });

    await runtime.gracefulShutdown({ exitProcess: false, deadline });

    expect(openCodeProcess.close).toHaveBeenCalledWith({ deadline: deadline - 500 });
  });

  it('stops input sources before closing managed OpenCode', async () => {
    const order = [];
    const runtime = createRuntime(null, {
      shouldSkipOpenCodeStop: () => false,
      getTerminalRuntime: () => ({ shutdown: vi.fn(async () => order.push('terminal')) }),
      getMessageStreamRuntime: () => ({ close: vi.fn(async () => order.push('stream')) }),
      getOpenCodeProcess: () => ({ close: vi.fn(async () => order.push('opencode')) }),
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(order.slice(0, 2).sort()).toEqual(['stream', 'terminal']);
    expect(order[2]).toBe('opencode');
  });

  it('still closes managed OpenCode when an input source throws synchronously', async () => {
    const openCodeProcess = { close: vi.fn(async () => {}) };
    const runtime = createRuntime(null, {
      shouldSkipOpenCodeStop: () => false,
      getTerminalRuntime: () => ({
        shutdown: vi.fn(() => {
          throw new Error('terminal shutdown failed');
        }),
      }),
      getOpenCodeProcess: () => openCodeProcess,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(openCodeProcess.close).toHaveBeenCalledTimes(1);
  });
});
