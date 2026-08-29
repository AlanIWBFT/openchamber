import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
const recordStartupPerformanceMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
  // `managed-process-registry.js` (imported transitively via lifecycle.js)
  // calls `promisify(execFile)` at module load, so the mock must expose a
  // function here. Lifecycle tests don't exercise the reaper path, so a plain
  // stub is enough; the registry's best-effort writes are no-ops on errors.
  execFile: vi.fn(),
}));
vi.mock('./startup-performance.js', () => ({
  recordStartupPerformance: recordStartupPerformanceMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  recordStartupPerformanceMock.mockReset();
  globalThis.fetch = originalFetch;
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.stdin.end = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => {
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
  });
  child.kill = vi.fn((signal = 'SIGTERM') => {
    child.signalCode = signal;
    queueMicrotask(() => {
      child.emit('exit', null, signal);
      child.emit('close', null, signal);
    });
    return true;
  });
  return child;
};

const createMockDetachedProcess = () => {
  const child = new EventEmitter();
  child.unref = vi.fn();
  return child;
};

const createRuntime = (overrides = {}, stateOverrides = {}, envOverrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    startingOpenCodeProcess: null,
    lastManagedOpenCodeLaunch: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    lastOpenCodeHealthFailure: null,
    lastManagedOpenCodeProcess: null,
    lastOpenCodeRestartDiagnostics: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
    ...stateOverrides,
  };

  const syncToHmrState = vi.fn();
  const runtime = createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
      ...envOverrides,
    },
    syncToHmrState,
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    supportsOpenCodeShutdownProtocol: vi.fn(() => true),
    reapManagedOrphanedProcesses: vi.fn(async () => ({ inspected: 0, reaped: 0 })),
    ...overrides,
  });
  runtime.testState = state;
  runtime.state = state;
  runtime.syncToHmrState = syncToHmrState;
  return runtime;
};

describe('OpenCode lifecycle', () => {
  it('records an authoritative ready terminal event for external startup', async () => {
    const onOpenCodeReady = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      onOpenCodeReady,
    });

    const result = await runtime.bootstrapOpenCodeAtStartup();

    expect(result).toEqual({ status: 'ready' });
    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.ready', {
      totalDurationMs: expect.any(Number),
      outcome: 'ready',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.error',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
    expect(onOpenCodeReady).toHaveBeenCalledTimes(1);
  });

  it('activates ready dependents after managed bootstrap passes its final health check', async () => {
    const child = createMockChild();
    const onOpenCodeReady = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime({
      onOpenCodeReady,
    }, {}, { ENV_EFFECTIVE_PORT: null });

    await expect(runtime.bootstrapOpenCodeAtStartup()).resolves.toEqual({ status: 'ready' });

    expect(onOpenCodeReady).toHaveBeenCalledTimes(1);
    await runtime.state.openCodeProcess.close();
  });

  it('recovers an external OPENCODE_HOST connection using its configured endpoint', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({}, {
      openCodePort: null,
      openCodeBaseUrl: null,
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await runtime.restartOpenCode();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://seamus:4095/global/health',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
    expect(runtime.testState.lastOpenCodeError).toBeNull();
  });

  it('retains the OPENCODE_HOST port after an external re-probe fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 4095,
      openCodeBaseUrl: 'http://seamus:4095',
      isExternalOpenCode: true,
    }, {
      ENV_CONFIGURED_OPENCODE_PORT: null,
      ENV_CONFIGURED_OPENCODE_HOST: { origin: 'http://seamus:4095', port: 4095 },
      ENV_EFFECTIVE_PORT: 4095,
    });

    await expect(runtime.restartOpenCode()).rejects.toThrow(
      'External OpenCode server on port 4095 is not responding',
    );

    expect(runtime.testState.openCodePort).toBe(4095);
    expect(runtime.testState.openCodeBaseUrl).toBe('http://seamus:4095');
  });

  it('warms recently used directories after a successful bootstrap', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ healthy: true }),
    }));
    globalThis.fetch = fetchMock;
    const runtime = createRuntime({
      env: {
        ENV_CONFIGURED_OPENCODE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOST: null,
        ENV_EFFECTIVE_PORT: 45678,
        ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
        ENV_SKIP_OPENCODE_START: true,
      },
      getWarmupDirectories: vi.fn(async () => ['/tmp/worktree-a', '/tmp/project-b']),
    });

    await runtime.bootstrapOpenCodeAtStartup();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const warmupUrls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.includes('/session/status'));
    expect(warmupUrls).toEqual([
      'http://127.0.0.1:45678/session/status?directory=%2Ftmp%2Fworktree-a',
      'http://127.0.0.1:45678/session/status?directory=%2Ftmp%2Fproject-b',
    ]);
  });

  it('records an authoritative error terminal event when bootstrap fails', async () => {
    const runtime = createRuntime({
      syncFromHmrState: vi.fn(() => {
        throw new Error('bootstrap failed');
      }),
    });

    const result = await runtime.bootstrapOpenCodeAtStartup();

    expect(result).toEqual({ status: 'failed', error: 'bootstrap failed' });
    expect(recordStartupPerformanceMock).toHaveBeenCalledWith('opencode.bootstrap.error', {
      totalDurationMs: expect.any(Number),
      outcome: 'error',
    });
    expect(recordStartupPerformanceMock).not.toHaveBeenCalledWith(
      'opencode.bootstrap.ready',
      expect.anything(),
    );
    const terminalEvents = recordStartupPerformanceMock.mock.calls.filter(([phase]) => (
      phase === 'opencode.bootstrap.ready' || phase === 'opencode.bootstrap.error'
    ));
    expect(terminalEvents).toHaveLength(1);
  });

  it('requests graceful shutdown over the managed control pipe', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime();

    await runtime.startOpenCode();
    runtime.state.isOpenCodeReady = true;
    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() + 1000 })).resolves.toEqual({ graceful: true });

    expect(child.stdin.end).toHaveBeenCalledWith(`${JSON.stringify({ version: 1, type: 'shutdown' })}\n`);
    expect(child.kill).not.toHaveBeenCalled();
    expect(runtime.state.isOpenCodeReady).toBe(false);
    expect(runtime.state.openCodeNotReadySince).toBeGreaterThan(0);
    expect(runtime.syncToHmrState).toHaveBeenCalled();
  });

  it('does not signal a managed child that already exited', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    child.exitCode = 1;

    await expect(server.close()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('publishes and closes a managed child that is still starting during shutdown', async () => {
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();

    const starting = runtime.startOpenCode();
    let startingError;
    const startingSettled = starting.catch((error) => {
      startingError = error;
    });
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(runtime.state.startingOpenCodeProcess).not.toBeNull();
    expect(runtime.state.startingOpenCodeProcess.pid).toBe(child.pid);
    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() + 1000 })).resolves.toEqual({ graceful: true });

    await startingSettled;
    expect(startingError).toBeInstanceOf(Error);
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(runtime.state.openCodeProcess).toBeNull();
  });

  it('does not count rapid transport-triggered checks as independent health failures', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let now = 1;
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({ now: () => now }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: null,
        signalCode: null,
        close,
      },
      isOpenCodeReady: true,
    });

    for (let attempt = 0; attempt < 25; attempt += 1) {
      await runtime.triggerHealthCheck();
    }

    expect(close).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);

    now += 15_000;
    await runtime.triggerHealthCheck();

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(expect.stringContaining('(2/20)'));
    warn.mockRestore();
  });

  it.each([
    {
      name: 'timeout',
      expectedClass: 'timeout',
      fetchResult: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
    },
    {
      name: 'connection refusal',
      expectedClass: 'connection_refused',
      fetchResult: () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:45678');
        error.code = 'ECONNREFUSED';
        throw error;
      },
    },
    {
      name: 'invalid JSON',
      expectedClass: 'invalid_response',
      fetchResult: () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token');
        },
      }),
    },
  ])('classifies and stores a counted $name health failure', async ({ expectedClass, fetchResult }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(fetchResult);
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        exitCode: null,
        signalCode: null,
        close: vi.fn(async () => {}),
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeHealthFailure).toEqual({
      class: expectedClass,
      detail: expect.any(String),
      at: expect.any(String),
      source: 'immediate',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`class=${expectedClass}`));
    warn.mockRestore();
  });

  it('does not mistake a live managed process wrapper for an exited child', async () => {
    const close = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: process.pid,
        close,
      },
      isOpenCodeReady: true,
    });

    await runtime.triggerHealthCheck();

    expect(close).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('(1/20)'));
    warn.mockRestore();
  });

  it('restarts an exited managed process without waiting for the failure interval', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime({}, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('calls onOpenCodeRestarted after a successful managed restart', async () => {
    const close = vi.fn(async () => {});
    const replacement = createMockChild();
    const onOpenCodeRestarted = vi.fn();
    const onOpenCodeReady = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime({ onOpenCodeRestarted, onOpenCodeReady }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await runtime.triggerHealthCheck();

    expect(close).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(onOpenCodeRestarted).toHaveBeenCalledTimes(1);
    expect(onOpenCodeReady).toHaveBeenCalledTimes(1);
  });

  it('retains post-listen stderr and exited process diagnostics across restart', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      `${'x'.repeat(40 * 1024)}\ntoken=runtime-secret\nruntime worker failed after startup\n`,
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.exitCode).toBe(7);
    expect(Buffer.byteLength(server.stderrTail)).toBeLessThanOrEqual(32 * 1024);
    expect(server.stderrTail).not.toContain('runtime-secret');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    expect(runtime.testState.lastOpenCodeRestartDiagnostics).toEqual({
      reason: 'immediate-process-exited',
      healthFailure: null,
      process: {
        pid: 12345,
        exitCode: 7,
        signalCode: null,
        stderrTail: expect.stringContaining('runtime worker failed after startup'),
        alive: false,
      },
      busySessionCount: 0,
      at: expect.any(String),
    });
    expect(runtime.testState.lastManagedOpenCodeProcess).toEqual({
      pid: 12345,
      exitCode: 7,
      signalCode: null,
      stderrTail: expect.stringContaining('runtime worker failed after startup'),
    });

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('redacts Authorization scheme credentials from stderr diagnostics', async () => {
    const firstChild = createMockChild();
    const replacement = createMockChild();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => null,
    }));
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        replacement.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return replacement;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    runtime.testState.openCodeProcess = server;

    firstChild.stderr.emit(
      'data',
      'request rejected: Authorization: Basic dXNlcjpwYXNz\n'
      + 'authorization: basic bG93ZXI6Y2FzZQ==\n'
      + 'Authorization: Bearer fake-bearer-token-value\n'
      + 'falling back to basic health monitor\n'
      + 'runtime worker failed after startup\n',
    );
    firstChild.exitCode = 7;
    firstChild.emit('exit', 7, null);

    expect(server.stderrTail).not.toContain('dXNlcjpwYXNz');
    expect(server.stderrTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(server.stderrTail).not.toContain('fake-bearer-token-value');
    expect(server.stderrTail).toContain('falling back to basic health monitor');
    expect(server.stderrTail).toContain('runtime worker failed after startup');

    await runtime.triggerHealthCheck();

    const diagnosticsTail = runtime.testState.lastOpenCodeRestartDiagnostics.process.stderrTail;
    expect(diagnosticsTail).not.toContain('dXNlcjpwYXNz');
    expect(diagnosticsTail).not.toContain('bG93ZXI6Y2FzZQ');
    expect(diagnosticsTail).not.toContain('fake-bearer-token-value');
    expect(diagnosticsTail).toContain('falling back to basic health monitor');
    expect(diagnosticsTail).toContain('runtime worker failed after startup');

    await runtime.testState.openCodeProcess.close();
    warn.mockRestore();
  });

  it('does not call onOpenCodeRestarted when a managed restart fails', async () => {
    const close = vi.fn(async () => {});
    const onOpenCodeRestarted = vi.fn();
    const onOpenCodeReady = vi.fn();
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => null,
    }));
    spawnMock.mockImplementation(() => {
      const child = createMockChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn failed'));
      });
      return child;
    });
    const runtime = createRuntime({ onOpenCodeRestarted, onOpenCodeReady }, {
      openCodePort: 45678,
      openCodeProcess: {
        pid: null,
        exitCode: 1,
        signalCode: null,
        close,
      },
    });

    await expect(runtime.restartOpenCode()).rejects.toThrow();

    expect(onOpenCodeRestarted).not.toHaveBeenCalled();
    expect(onOpenCodeReady).not.toHaveBeenCalled();
  });

  it('force-stops OpenCode within the shared shutdown deadline', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    await expect(server.close({ deadline: Date.now() + 1500, force: true })).resolves.toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it('forces termination only after the configured graceful shutdown window', async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    const killer = createMockDetachedProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    spawnMock.mockReturnValueOnce(killer);
    const runtime = createRuntime();
    await runtime.startOpenCode();
    child.stdin.end = vi.fn(() => {});
    child.kill = vi.fn((signal = 'SIGTERM') => {
      if (signal !== 'SIGKILL') return true;
      child.signalCode = signal;
      queueMicrotask(() => child.emit('close', null, signal));
      return true;
    });
    const shutdown = runtime.stopManagedOpenCode({ deadline: Date.now() + 100 });

    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expect(child.stdin.end).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();

    vi.runAllTimers();
    await Promise.resolve();
    await Promise.resolve();
    await expect(shutdown).resolves.toEqual({ graceful: false });
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenNthCalledWith(2, 'taskkill', ['/pid', String(child.pid), '/f', '/t'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      expect(killer.unref).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    }
  });

  it('does not wait for or retry a force dispatch after the shutdown deadline', async () => {
    const child = createMockChild();
    const killer = createMockDetachedProcess();
    child.stdin.end = vi.fn(() => {});
    child.kill = vi.fn(() => true);
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    spawnMock.mockReturnValueOnce(killer);
    const runtime = createRuntime();
    await runtime.startOpenCode();

    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() }))
      .resolves.toEqual({ graceful: false });

    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(killer.unref).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(child.kill).toHaveBeenCalledTimes(1);
    }
    expect(runtime.state.openCodeProcess).toBeNull();
  });

  it('sends one versioned shutdown message without spawning another process', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const runtime = createRuntime();
    await runtime.startOpenCode();
    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() + 1000 })).resolves.toEqual({ graceful: true });

    expect(child.stdin.end).toHaveBeenCalledWith(`${JSON.stringify({ version: 1, type: 'shutdown' })}\n`);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('does not start cleanup work after the managed process reference was cleared', async () => {
    const runtime = createRuntime({}, {
      lastManagedOpenCodeLaunch: {
        binary: 'opencode',
        args: [],
        cwd: '/tmp/project',
        env: { PATH: '/usr/bin' },
        shutdownProtocol: true,
      },
    });

    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() + 1000 })).resolves.toEqual({ graceful: false });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('passes the entire shutdown deadline to managed protocol shutdown', async () => {
    const close = vi.fn(async () => {});
    const shutdown = vi.fn(async () => true);
    const runtime = createRuntime({}, {
      openCodeProcess: {
        pid: 12345,
        exitCode: null,
        signalCode: null,
        close,
        shutdown,
      },
    });
    const now = Date.UTC(2026, 7, 4);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await expect(runtime.stopManagedOpenCode({ deadline: now + 5000 })).resolves.toEqual({ graceful: true });

      expect(shutdown).toHaveBeenCalledWith({ deadline: now + 5000 });
      expect(close).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns safe process information when only the last launch remains', () => {
    const runtime = createRuntime({}, {
      lastManagedOpenCodeLaunch: {
        binary: 'opencode',
        args: [],
        cwd: '/tmp/project',
        env: {},
        shutdownProtocol: true,
      },
      openCodePort: 45678,
    });

    expect(runtime.getManagedOpenCodeProcessInfo()).toEqual({
      managed: true,
      pid: null,
      port: null,
    });
  });

  it('force-terminates immediately when the selected CLI lacks the private shutdown capability', async () => {
    const child = createMockChild();
    const killer = createMockDetachedProcess();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    spawnMock.mockReturnValueOnce(killer);
    const runtime = createRuntime({ supportsOpenCodeShutdownProtocol: () => false });
    await runtime.startOpenCode();

    await expect(runtime.stopManagedOpenCode({ deadline: Date.now() + 1000 })).resolves.toEqual({ graceful: false });

    expect(child.stdin.end).not.toHaveBeenCalled();
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledTimes(2);
      expect(killer.unref).toHaveBeenCalledTimes(1);
      expect(child.kill).not.toHaveBeenCalled();
    } else {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(spawnMock).toHaveBeenCalledTimes(1);
    }
  });

  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');
    expect(options.env.OPENCHAMBER_SHUTDOWN_PROTOCOL).toBe('1');
    expect(options.env.OPENCODE_STARTUP_PROTOCOL).toBe('1');
    expect(server.exitCode).toBeNull();
    expect(server.signalCode).toBeNull();
    expect(options.stdio).toEqual(['pipe', 'pipe', 'pipe']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('suspends the startup timeout while OpenCode reports a database migration', async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();
    const phases = [];
    runtime.onOpenCodeStartupState((value) => phases.push(value.phase));

    const starting = runtime.startOpenCode();
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await Promise.resolve();
    }
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"started"}\n');

    vi.advanceTimersByTime(60_000);
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();
    expect(runtime.getOpenCodeStartupState()).toEqual({ phase: 'migrating' });

    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"completed"}\n');
    child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
    const server = await starting;

    expect(phases).toEqual(['idle', 'launching', 'migrating', 'launching', 'ready']);
    await server.close();
  });

  it('does not retry a managed child that exits during database migration', async () => {
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();

    const starting = runtime.startOpenCode();
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await Promise.resolve();
    }
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"started"}\n');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.emit('close', 1, null);

    await expect(starting).rejects.toThrow('OpenCode process exited before serving with code 1');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(runtime.getOpenCodeStartupState()).toMatchObject({ phase: 'failed' });
  });

  it('does not retry a migration preflight failure before migration starts', async () => {
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();
    const phases = [];
    runtime.onOpenCodeStartupState((value) => phases.push(value.phase));

    const starting = runtime.startOpenCode();
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await Promise.resolve();
    }
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"failed"}\n');
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.stderr.emit('data', 'Database is not empty and has no session table\n');
    child.emit('close', 1, null);

    await expect(starting).rejects.toThrow('Database is not empty and has no session table');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(phases).toEqual(['idle', 'launching', 'failed']);
  });

  it('drains migration failure diagnostics before rejecting startup', async () => {
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();

    const starting = runtime.startOpenCode();
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await Promise.resolve();
    }
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"started"}\n');
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"failed"}\n');

    expect(child.kill).not.toHaveBeenCalled();
    child.exitCode = 1;
    child.emit('exit', 1, null);
    child.stderr.emit('data', 'SQLITE_CONSTRAINT: migration exploded\n');
    child.emit('close', 1, null);

    await expect(starting).rejects.toThrow('SQLITE_CONSTRAINT: migration exploded');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('bounds diagnostic draining when a failed migration process does not exit', async () => {
    vi.useFakeTimers();
    const child = createMockChild();
    spawnMock.mockReturnValueOnce(child);
    const runtime = createRuntime();

    const starting = runtime.startOpenCode();
    for (let attempt = 0; attempt < 100 && runtime.state.startingOpenCodeProcess === null; attempt += 1) {
      await Promise.resolve();
    }
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"started"}\n');
    child.stdout.emit('data', 'opencode lifecycle {"version":1,"type":"database-migration","state":"failed"}\n');
    child.stderr.emit('data', 'migration process remained alive\n');

    const failure = starting.catch((error) => error);
    for (let attempt = 0; attempt < 10; attempt += 1) await Promise.resolve();
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();

    expect((await failure).message).toContain('migration process remained alive');
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('launches managed OpenCode on the configured bind hostname', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://0.0.0.0:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({}, {}, { ENV_CONFIGURED_OPENCODE_HOSTNAME: '0.0.0.0' });
    const server = await runtime.startOpenCode();
    const [binary, args] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '0.0.0.0', '--port', '45678']);

    await server.close();
    expect(server.signalCode).toBe('SIGTERM');
  });

  it('strips AppImage ARGV0 from managed OpenCode launch env', async () => {
    delete process.env.OPENCODE_BINARY;
    const previousArgv0 = process.env.ARGV0;
    process.env.ARGV0 = '/path/to/OpenChamber/OpenChamber-1.17.2-linux-x86_64.AppImage';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    try {
      const runtime = createRuntime({
        getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
          PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
          ARGV0: '/leaked/from/shell/snapshot.AppImage',
          SHELL_ONLY: 'yes',
        })),
      });
      const server = await runtime.startOpenCode();
      const [, , options] = spawnMock.mock.calls[0];

      expect(options.env).not.toHaveProperty('ARGV0');
      expect(options.env.SHELL_ONLY).toBe('yes');
      expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');

      await server.close();
    } finally {
      if (previousArgv0 === undefined) delete process.env.ARGV0;
      else process.env.ARGV0 = previousArgv0;
    }
  });

  it('adds managed OpenChamber tool environment without allowing it to replace launch invariants', async () => {
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });
    const getManagedOpenCodeEnv = vi.fn(async () => ({
      OPENCODE_CONFIG_CONTENT: '{"plugin":["file:///tool.js"]}',
      OPENCHAMBER_AGENT_TOOL_TOKEN: 'ephemeral',
      PATH: '/untrusted/path',
      OPENCODE_SERVER_PASSWORD: 'untrusted-password',
    }));

    const runtime = createRuntime({ getManagedOpenCodeEnv });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(getManagedOpenCodeEnv).toHaveBeenCalledOnce();
    expect(options.env.OPENCODE_CONFIG_CONTENT).toBe('{"plugin":["file:///tool.js"]}');
    expect(options.env.OPENCHAMBER_AGENT_TOOL_TOKEN).toBe('ephemeral');
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.signalCode = 'SIGTERM';
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.signalCode = 'SIGTERM';
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.signalCode = 'SIGTERM';
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });
});

describe('killProcessOnPort on Windows', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  const setPlatform = (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  };

  it('does not terminate an unrelated process that owns the target port', () => {
    setPlatform('win32');

    const runtime = createRuntime();
    runtime.killProcessOnPort(45678);

    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
