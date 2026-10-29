import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createGracefulShutdownRuntime, createShutdownFence } from './shutdown-runtime.js';
import { createAutoReviewRuntime } from '../auto-review/runtime.js';

const createRuntime = (server, overrides = {}) => {
  const runtime = createGracefulShutdownRuntime({
    process: { exit: vi.fn() },
    shutdownTimeoutMs: 1000,
    getExitOnShutdown: () => false,
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
    stopManagedOpenCode: vi.fn(async () => ({ graceful: false })),
    getServer: () => server,
    getUiAuthController: () => null,
    setUiAuthController: vi.fn(),
    getActiveTunnelController: () => null,
    setActiveTunnelController: vi.fn(),
    tunnelAuthController: { clearActiveTunnel: vi.fn() },
    beginGuestServiceShutdown: vi.fn(),
    stopAllGuestServices: vi.fn(),
    getGuestSurfaceRuntime: () => null,
    getRealtimeProxyRuntime: () => null,
    getDictationRuntime: () => null,
    getRelayService: () => null,
    getRelayReconcileTimer: () => null,
    ...overrides,
  });
  if (server instanceof http.Server) runtime.trackServerConnections(server);
  return runtime;
};

describe('graceful shutdown runtime', () => {
  it('joins terminal grace alongside managed OpenCode cleanup within the desktop budget', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const completed = [];
    const runtime = createRuntime(null, {
      shutdownTimeoutMs: 35000,
      stopManagedOpenCode: async ({ deadline }) => {
        expect(deadline).toBe(start + 35000 - 500);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        completed.push('opencode');
      },
      getTerminalRuntime: () => ({ shutdown: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20000));
        completed.push('terminals');
      } }),
    });
    let finished = false;
    const shutdown = runtime.gracefulShutdown().then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(completed).toEqual(['opencode']);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(15000);
    await shutdown;
    expect(completed).toEqual(['opencode', 'terminals']);
    expect(Date.now() - start).toBe(20000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])('waits for an in-flight review Stop to persist before exit (cleanup fails: %s)', async (stopFails) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-review-shutdown-'));
    const filePath = path.join(dataDir, 'auto-review.json');
    const writePaused = Promise.withResolvers();
    const resumeWrite = Promise.withResolvers();
    const rename = fs.rename.bind(fs);
    let pauseNextWrite = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === filePath && pauseNextWrite) {
        pauseNextWrite = false;
        writePaused.resolve();
        await resumeWrite.promise;
      }
      return rename(from, to);
    });
    const fetchImpl = vi.fn(async (url) => {
      expect(new URL(url).pathname).toMatch(/^\/api\/session\/ses_(original|review)\/stop$/);
      return Response.json({ matched: 1, terminated: stopFails ? 0 : 1, failed: stopFails ? 1 : 0 });
    });
    const dependencies = {
      dataDir,
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}),
      fetchImpl,
    };
    const autoReviewRuntime = createAutoReviewRuntime(dependencies);
    const exit = vi.fn();
    const stopManagedOpenCode = vi.fn(async () => {});
    const runtime = createRuntime(null, { autoReviewRuntime, process: { exit }, stopManagedOpenCode, shutdownTimeoutMs: 35000 });
    let stopping;
    let shutdown;
    let restarted;
    try {
      await autoReviewRuntime.startRun({
        originalSessionID: 'ses_original',
        reviewSessionID: 'ses_review',
        directory: '/repo',
        prompts: { reviewStart: 'Review.', reviewRules: 'Rules.', feedbackToImplementer: '{{review_feedback}}', responseToReviewer: '{{implementation_response}}' },
      });
      pauseNextWrite = true;
      stopping = autoReviewRuntime.removeRun('ses_original').then(() => null, (error) => error);
      await writePaused.promise;
      shutdown = runtime.gracefulShutdown({ exitProcess: true });
      // Let shutdown's other cleanup promises settle while the real rename is held.
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopManagedOpenCode).toHaveBeenCalledOnce();
      expect(exit).not.toHaveBeenCalled();
      expect(autoReviewRuntime.snapshot().runs[0].status).toBe('stopping');
      expect(JSON.parse(await fs.readFile(filePath, 'utf8')).runs[0].status).toBe('running');

      resumeWrite.resolve();
      await shutdown;
      expect(exit).toHaveBeenCalledExactlyOnceWith(0);
      expect(Boolean(await stopping)).toBe(stopFails);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
      expect(saved.runs.map((run) => run.status)).toEqual(stopFails ? ['stop_failed'] : []);
      restarted = createAutoReviewRuntime(dependencies);
      await restarted.load();
      expect(restarted.isRunning('ses_original')).toBe(false);
      expect(restarted.holdsDelivery('ses_original')).toBe(stopFails);
    } finally {
      resumeWrite.resolve();
      autoReviewRuntime.stop();
      restarted?.stop();
      await stopping;
      await autoReviewRuntime.flush();
      await shutdown;
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  it('bounds the review drain by the shared deadline and keeps HTTP finalization time', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const start = Date.now();
    const pending = Promise.withResolvers();
    const autoReviewRuntime = { stop: vi.fn(), flush: vi.fn(() => pending.promise) };
    const stopManagedOpenCode = vi.fn(async () => {});
    const server = { close: vi.fn((callback) => callback()) };
    const runtime = createRuntime(server, { autoReviewRuntime, stopManagedOpenCode });
    let finished = false;
    const shutdown = runtime.gracefulShutdown({ deadline: start + 35000 }).then(() => { finished = true; });
    expect(autoReviewRuntime.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(34499);
    expect(stopManagedOpenCode).toHaveBeenCalledExactlyOnceWith({ deadline: start + 34500 });
    expect(autoReviewRuntime.flush).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await shutdown;
    expect(server.close).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('Error stopping backend resources:', expect.objectContaining({ message: 'Auto-review shutdown timed out' }));
    expect(vi.getTimerCount()).toBe(0);
    // Late failure of a timed-out drain is still observed, not an unhandled rejection.
    pending.reject(new Error('late review failure'));
    await Promise.resolve();
  });

  it.each([false, true])('clears the review drain timer and completes shutdown (flush rejects: %s)', async (rejects) => {
    vi.useFakeTimers();
    const failure = new Error('review drain failed');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const flush = vi.fn(async () => { if (rejects) throw failure; });
    const exit = vi.fn();
    const runtime = createRuntime(null, { autoReviewRuntime: { stop: vi.fn(), flush }, process: { exit } });
    await runtime.gracefulShutdown({ exitProcess: true });
    expect(flush).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    if (rejects) expect(warning).toHaveBeenCalledWith('Error stopping backend resources:', failure);
    else expect(warning).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
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
    const runtime = createRuntime(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const request = http.get(`http://127.0.0.1:${server.address().port}`);
    request.on('error', () => {});
    const response = await new Promise((resolve) => request.once('response', resolve));
    response.resume();
    const closed = new Promise((resolve) => response.once('close', resolve));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runtime.gracefulShutdown({ exitProcess: false });
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await closed;
    } finally {
      request.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.each([false, true])('closes upgraded sockets without the HTTP timeout (handshake completed: %s)', async (completeHandshake) => {
    const server = http.createServer();
    const runtime = createRuntime(server);
    const sockets = new Set();
    server.on('upgrade', (_request, socket) => {
      sockets.add(socket);
      if (completeHandshake) {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      }
      // A listener for another WS route can leave the upgrade unanswered.
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', () => {});
    client.resume();
    const clientClosed = once(client, 'close');
    const upgraded = once(server, 'upgrade');
    client.write('GET /api/global/event/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    await upgraded;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runtime.gracefulShutdown({ exitProcess: false });
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await clientClosed;
      const connections = await new Promise((resolve, reject) => {
        server.getConnections((error, count) => error ? reject(error) : resolve(count));
      });
      expect(connections).toBe(0);
    } finally {
      for (const socket of sockets) socket.destroy();
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('starts managed cleanup without waiting for guests and rejects new sockets while draining existing ones', async () => {
    const server = http.createServer();
    const cleanupStarted = Promise.withResolvers();
    const finishCleanup = Promise.withResolvers();
    const sockets = new Set();
    const clients = [];
    server.on('upgrade', (_request, socket) => sockets.add(socket));
    const terminalShutdown = vi.fn(async () => {
      expect([...sockets].every((socket) => !socket.destroyed)).toBe(true);
    });
    const processClose = vi.fn(async () => {
      expect(terminalShutdown).toHaveBeenCalledOnce();
      expect([...sockets].every((socket) => !socket.destroyed)).toBe(true);
    });
    const runtime = createRuntime(server, {
      stopAllGuestServices: async () => {
        cleanupStarted.resolve();
        await finishCleanup.promise;
        throw new Error('fixture cleanup failure');
      },
      getTerminalRuntime: () => ({ shutdown: terminalShutdown }),
      stopManagedOpenCode: processClose,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const closed = [];
    for (let index = 0; index < 8; index += 1) {
      const client = net.connect(server.address().port, '127.0.0.1');
      clients.push(client);
      client.resume();
      closed.push(once(client, 'close'));
      const upgraded = once(server, 'upgrade');
      client.write('GET /api/global/event/ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      await upgraded;
    }
    const shutdown = runtime.gracefulShutdown({ exitProcess: false });
    expect(runtime.gracefulShutdown({ exitProcess: false })).toBe(shutdown);
    await cleanupStarted.promise;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const late = net.connect(server.address().port, '127.0.0.1');
      clients.push(late);
      late.on('error', () => {});
      await new Promise((resolve) => late.once('close', resolve));
      expect(sockets.size).toBe(8);
      expect(processClose).toHaveBeenCalledOnce();
      finishCleanup.resolve();
      await shutdown;
      expect(processClose).toHaveBeenCalledOnce();
      expect(warning).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
      await Promise.all(closed);
      expect(server.listening).toBe(false);
    } finally {
      finishCleanup.resolve();
      for (const socket of sockets) socket.destroy();
      for (const client of clients) client.destroy();
      await shutdown;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('stops guest services during shutdown', async () => {
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };
    const stopAllGuestServices = vi.fn(async () => {});

    const runtime = createRuntime(server, { stopAllGuestServices });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
  });

  it('continues shutdown when stopping guest services fails', async () => {
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };
    const stopAllGuestServices = vi.fn(async () => {
      throw new Error('guest teardown failed');
    });
    const terminalRuntime = { shutdown: vi.fn(async () => {}) };

    const runtime = createRuntime(server, {
      stopAllGuestServices,
      getTerminalRuntime: () => terminalRuntime,
    });
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
    expect(terminalRuntime.shutdown).toHaveBeenCalledTimes(1);
    expect(server.close).toHaveBeenCalled();
  });

  it('closes guest admission synchronously and cleans every runtime once across repeated shutdown calls', async () => {
    vi.useFakeTimers();
    const order = [];
    const cleanup = (name) => vi.fn(() => { order.push(name); });
    const viewers = { stop: cleanup('viewers') };
    const proxy = { stop: cleanup('proxy') };
    const dictation = { stop: cleanup('dictation') };
    const relay = { shutdown: cleanup('relay') };
    const gate = cleanup('gate');
    const guests = cleanup('guests');
    const reconcile = vi.fn();
    const timer = setInterval(reconcile, 100);
    const runtime = createRuntime(null, {
      beginGuestServiceShutdown: gate,
      stopAllGuestServices: guests,
      getGuestSurfaceRuntime: () => viewers,
      getRealtimeProxyRuntime: () => proxy,
      getDictationRuntime: () => dictation,
      getRelayService: () => relay,
      getRelayReconcileTimer: () => timer,
    });
    const first = runtime.gracefulShutdown();
    expect(gate).toHaveBeenCalledTimes(1);
    expect(runtime.gracefulShutdown()).toBe(first);
    await first;
    await runtime.gracefulShutdown();
    expect(order).toEqual(['gate', 'viewers', 'proxy', 'relay', 'dictation', 'guests']);
    await vi.advanceTimersByTimeAsync(200);
    expect(reconcile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates failed viewer and relay cleanup and still drains guests and exits', async () => {
    const stop = vi.fn(() => { throw new Error('stop failed'); });
    const stopAllGuestServices = vi.fn(async () => {});
    const dictation = { stop: vi.fn() };
    const process = { exit: vi.fn() };
    const runtime = createRuntime(null, {
      process,
      getGuestSurfaceRuntime: () => ({ stop }),
      getRelayService: () => ({ shutdown: stop }),
      getDictationRuntime: () => dictation,
      stopAllGuestServices,
    });
    await runtime.gracefulShutdown({ exitProcess: true });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(dictation.stop).toHaveBeenCalledTimes(1);
    expect(stopAllGuestServices).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('reserves time after managed OpenCode shutdown for HTTP finalization', async () => {
    const openCodeProcess = { close: vi.fn(async () => {}) };
    const deadline = Date.now() + 15000;
    const runtime = createRuntime(null, {
      stopManagedOpenCode: openCodeProcess.close,
    });

    await runtime.gracefulShutdown({ exitProcess: false, deadline });

    expect(openCodeProcess.close).toHaveBeenCalledWith({ deadline: deadline - 500 });
  });

  it('initiates input drains before the managed OpenCode drain', async () => {
    const order = [];
    const runtime = createRuntime(null, {
      getTerminalRuntime: () => ({ shutdown: vi.fn(async () => order.push('terminal')) }),
      getMessageStreamRuntime: () => ({ close: vi.fn(async () => order.push('stream')) }),
      stopManagedOpenCode: vi.fn(async () => order.push('opencode')),
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(order.slice(0, 2).sort()).toEqual(['stream', 'terminal']);
    expect(order[2]).toBe('opencode');
  });

  it('still closes managed OpenCode when an input source throws synchronously', async () => {
    const openCodeProcess = { close: vi.fn(async () => {}) };
    const runtime = createRuntime(null, {
      getTerminalRuntime: () => ({
        shutdown: vi.fn(() => {
          throw new Error('terminal shutdown failed');
        }),
      }),
      stopManagedOpenCode: openCodeProcess.close,
    });

    await runtime.gracefulShutdown({ exitProcess: false });

    expect(openCodeProcess.close).toHaveBeenCalledTimes(1);
  });

  it('preserves the terminal grace period within the longer shared deadline', async () => {
    vi.useFakeTimers();
    const deadline = Date.now() + 35_000;
    const openCodeProcess = { close: vi.fn(async () => {}) };
    const runtime = createRuntime(null, {
      getTerminalRuntime: () => ({ shutdown: () => new Promise((resolve) => setTimeout(resolve, 20_000)) }),
      stopManagedOpenCode: openCodeProcess.close,
    });
    let finished = false;
    const shutdown = runtime.gracefulShutdown({ exitProcess: false, deadline }).then(() => { finished = true; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(openCodeProcess.close).toHaveBeenCalledWith({ deadline: deadline - 500 });
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(18_000);
    await shutdown;
    expect(openCodeProcess.close).toHaveBeenCalledWith({ deadline: deadline - 500 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
