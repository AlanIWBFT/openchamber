import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';

import { createGracefulShutdownRuntime, createShutdownFence } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  stopBackgroundResources: vi.fn(),
  stopManagedOpenCode: vi.fn(async () => {}),
  stopGuestServices: vi.fn(async () => {}),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('rejects new requests after shutdown begins', () => {
    let shuttingDown = false;
    const next = vi.fn();
    const response = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    };
    const fence = createShutdownFence(() => shuttingDown);

    fence({}, response, next);
    expect(next).toHaveBeenCalledTimes(1);

    shuttingDown = true;
    fence({}, response, next);
    expect(response.setHeader).toHaveBeenCalledWith('Connection', 'close');
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ error: 'OpenChamber is shutting down' });
    expect(next).toHaveBeenCalledTimes(1);
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

  it('closes an active HTTP stream instead of waiting for the shutdown deadline', async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: fixture\n\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const request = http.get(`http://127.0.0.1:${server.address().port}`);
    request.on('error', () => {});
    const response = await new Promise((resolve) => request.once('response', resolve));
    response.resume();
    const closed = new Promise((resolve) => response.once('close', resolve));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await createRuntime(server).gracefulShutdown({ exitProcess: false });
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await closed;
    } finally {
      request.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('passes the shutdown deadline to the single managed process owner', async () => {
    const stopManagedOpenCode = vi.fn(async () => {});
    const deadline = Date.now() + 15000;
    const runtime = createRuntime(null, {
      stopManagedOpenCode,
    });

    await runtime.gracefulShutdown({ exitProcess: false, deadline });

    expect(stopManagedOpenCode).toHaveBeenCalledWith({ deadline });
  });

  it('stops input sources before closing managed OpenCode', async () => {
    const order = [];
    const runtime = createRuntime(null, {
      stopBackgroundResources: () => { order.push('terminal', 'stream'); },
      stopManagedOpenCode: async () => { order.push('opencode'); },
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(order.slice(0, 2).sort()).toEqual(['stream', 'terminal']);
    expect(order[2]).toBe('opencode');
  });

  it('still closes managed OpenCode when an input source throws synchronously', async () => {
    const stopManagedOpenCode = vi.fn(async () => {});
    const runtime = createRuntime(null, {
      stopBackgroundResources: () => { throw new Error('terminal shutdown failed'); },
      stopManagedOpenCode,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(stopManagedOpenCode).toHaveBeenCalledTimes(1);
  });

  it('joins guest cleanup and shares repeated shutdown requests', async () => {
    let release;
    const guestStopped = new Promise((resolve) => { release = resolve; });
    const stopManagedOpenCode = vi.fn(async () => {});
    const stopGuestServices = vi.fn(() => guestStopped);
    const runtime = createRuntime(null, { stopManagedOpenCode, stopGuestServices });
    let finished = false;
    const first = runtime.gracefulShutdown({ exitProcess: false });
    expect(runtime.gracefulShutdown({ exitProcess: false })).toBe(first);
    void first.then(() => { finished = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    expect(stopManagedOpenCode).toHaveBeenCalledTimes(1);
    expect(stopGuestServices).toHaveBeenCalledTimes(1);
    expect(stopGuestServices).toHaveBeenCalledWith({ shutdown: true });
    release();
    await first;
    expect(finished).toBe(true);
  });
});
