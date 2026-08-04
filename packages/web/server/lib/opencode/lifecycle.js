import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { stripAppImageArgv0Leak } from '../inherited-env.js';
import { registerManagedProcess, unregisterManagedProcess, reapOrphanedProcesses } from './managed-process-registry.js';
import { applyProviderEnvAliases } from './provider-env-aliases.js';
import { recordStartupPerformance } from './startup-performance.js';

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const HEALTH_CHECK_TIMEOUT_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_TIMEOUT_MS, 5000);
const HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES = parsePositiveInt(
  process.env.OPENCHAMBER_OPENCODE_HEALTH_CONSECUTIVE_FAILURES,
  20
);
const HEALTH_CHECK_INTERVAL_OVERRIDE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_INTERVAL_MS, 0);
const HEALTH_CHECK_RESULT_CACHE_MS = parsePositiveInt(process.env.OPENCHAMBER_OPENCODE_HEALTH_CACHE_MS, 750);
const OPENCODE_HEALTH_PATH = '/global/health';
// Last-used directory plus the three most recently opened projects — deeper
// tails are unlikely to be the user's first click and just add background work.
const WARMUP_DIRECTORY_LIMIT = 4;
const WARMUP_REQUEST_TIMEOUT_MS = 30000;
const MANAGED_SHUTDOWN_TIMEOUT_MS = 5000;
const MANAGED_PROCESS_TERMINATION_TIMEOUT_MS = 2000;
const SQLITE_FINALIZE_ARGUMENT = '__openchamber-sqlite-finalize';
const SQLITE_FINALIZE_ENV = 'OPENCHAMBER_SQLITE_FINALIZE';

export const createOpenCodeLifecycleRuntime = (deps) => {
  const {
    state,
    env,
    syncToHmrState,
    syncFromHmrState,
    getOpenCodeAuthHeaders,
    buildOpenCodeUrl,
    waitForReady,
    normalizeApiPrefix,
    applyOpencodeBinaryFromSettings,
    ensureOpencodeCliEnv,
    ensureLocalOpenCodeServerPassword,
    resolveManagedOpenCodeLaunchSpec,
    setOpenCodePort,
    setDetectedOpenCodeApiPrefix,
    setupProxy,
    ensureOpenCodeApiPrefix,
    clearResolvedOpenCodeBinary,
    buildAugmentedPath,
    buildManagedOpenCodePath,
    getManagedOpenCodeShellEnvSnapshot,
    getManagedOpenCodeEnv = async () => ({}),
    supportsOpenCodeSqliteFinalizer = () => false,
    getActiveSessionCount = () => 0,
    reapManagedOrphanedProcesses = reapOrphanedProcesses,
    getWarmupDirectories = async () => [],
    onOpenCodeRestarted = null,
    now = Date.now,
  } = deps;

  const killProcessOnPort = (port, timeoutMs = 5000) => {
    if (!port || process.platform === 'win32') return;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const remaining = () => Math.max(0, deadline - Date.now());
    if (remaining() === 0) return;
    try {
      const result = spawnSync('lsof', ['-ti', `:${port}`], {
        encoding: 'utf8',
        timeout: remaining(),
        windowsHide: true,
      });
      const output = result.stdout || '';
      const myPid = process.pid;
      for (const pidStr of output.split(/\s+/)) {
        const pid = parseInt(pidStr.trim(), 10);
        if (pid && pid !== myPid) {
          const killTimeout = remaining();
          if (killTimeout === 0) return;
          try {
            spawnSync('kill', ['-9', String(pid)], { stdio: 'ignore', timeout: killTimeout });
          } catch {
          }
        }
      }
    } catch {
    }
  };

  const hasChildProcessExited = (child) => !child
    || (child.exitCode !== null && child.exitCode !== undefined)
    || (child.signalCode !== null && child.signalCode !== undefined);

  const isManagedOpenCodeProcessAlive = () => {
    const child = state.openCodeProcess;
    if (!child || hasChildProcessExited(child)) return false;
    if (!child.pid) return true;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  const assertNotShuttingDown = () => {
    if (state.isShuttingDown) {
      const error = new Error('OpenCode startup cancelled during shutdown');
      error.code = 'OPENCHAMBER_SHUTTING_DOWN';
      throw error;
    }
  };

  const waitForChildProcessClose = (child, timeoutMs) => new Promise((resolve) => {
    if (!child || hasChildProcessExited(child)) {
      resolve(true);
      return;
    }

    let done = false;
    const finish = (closed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(closed);
    };

    const onClose = () => finish(true);
    const onError = () => finish(hasChildProcessExited(child));
    const timer = setTimeout(() => finish(hasChildProcessExited(child)), timeoutMs);

    child.once('close', onClose);
    child.once('error', onError);
  });

  const waitForPortRelease = (port, timeoutMs, hostname = env.ENV_CONFIGURED_OPENCODE_HOSTNAME) => {
    if (!port) {
      return Promise.resolve(true);
    }
    if (timeoutMs <= 0) return Promise.resolve(false);

    const probeHost = !hostname || hostname === '0.0.0.0' || hostname === '::' || hostname === '[::]'
      ? '127.0.0.1'
      : hostname;
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve) => {
      const attempt = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          resolve(false);
          return;
        }
        const socket = net.connect({ port, host: probeHost });
        let settled = false;

        const finish = (released) => {
          if (settled) return;
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          if (released || Date.now() >= deadline) {
            resolve(released);
            return;
          }
          setTimeout(attempt, Math.min(150, deadline - Date.now()));
        };

        socket.once('connect', () => finish(false));
        socket.once('timeout', () => finish(true));
        socket.once('error', (error) => {
          if (error && typeof error === 'object' && (error.code === 'ECONNREFUSED' || error.code === 'EHOSTUNREACH')) {
            finish(true);
            return;
          }
          finish(false);
        });
        socket.setTimeout(Math.min(500, remaining));
      };

      attempt();
    });
  };

  const terminateChildProcess = async (child, timeoutMs, options = {}) => {
    if (!child) {
      return true;
    }

    const pid = child.pid;
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const remaining = () => Math.max(0, deadline - Date.now());
    if (!pid || hasChildProcessExited(child)) {
      await waitForChildProcessClose(child, Math.min(250, remaining()));
      return hasChildProcessExited(child);
    }

    const signalProcessTree = (signal) => {
      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, signal);
        } catch {
        }
      }
      try { child.kill(signal); } catch {}
    };

    const forceProcessTree = () => {
      if (process.platform !== 'win32') {
        signalProcessTree('SIGKILL');
        return;
      }

      try {
        spawnSync('taskkill', ['/pid', String(pid), '/f', '/t'], {
          stdio: 'ignore',
          timeout: Math.max(1, remaining()),
          windowsHide: true,
        });
      } catch {
      }
    };

    if (remaining() === 0) {
      forceProcessTree();
      try { child.kill('SIGKILL'); } catch {}
      return hasChildProcessExited(child);
    }

    if (options.force === true) {
      forceProcessTree();
      if (await waitForChildProcessClose(child, Math.min(200, remaining()))) return true;
      try { child.kill('SIGKILL'); } catch {}
      return await waitForChildProcessClose(child, remaining());
    }

    if (process.platform === 'win32') {
      try { child.kill(); } catch {}
    } else {
      signalProcessTree('SIGTERM');
    }
    if (await waitForChildProcessClose(child, Math.min(process.platform === 'win32' ? 800 : 2500, remaining()))) {
      return true;
    }
    forceProcessTree();
    return await waitForChildProcessClose(child, remaining());
  };

  const closeManagedOpenCodeChild = async (child, options = {}) => {
    const pid = child?.pid;
    const deadline = typeof options.deadline === 'number' && Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + MANAGED_SHUTDOWN_TIMEOUT_MS;
    const remaining = () => Math.max(0, deadline - Date.now());
    try {
      if (!hasChildProcessExited(child)) {
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
      }
      const exited = await terminateChildProcess(child, remaining(), options);
      if (!exited) {
        const error = new Error(`OpenCode process ${pid || '(unknown)'} did not exit before the shutdown deadline`);
        error.code = 'OPENCHAMBER_OPENCODE_EXIT_UNCONFIRMED';
        throw error;
      }
    } finally {
      // Drop it from the registry only once it has actually exited, so a child
      // that survived teardown stays eligible for the next run's reaper.
      if (Number.isInteger(pid) && hasChildProcessExited(child)) {
        unregisterManagedProcess(pid);
      }
    }
  };

  const finalizeManagedOpenCodeDatabase = async (launch, timeoutMs) => {
    if (!launch || timeoutMs <= 0) {
      const error = new Error('No time remains to finalize the OpenCode database');
      error.code = 'OPENCHAMBER_OPENCODE_FINALIZE_TIMEOUT';
      throw error;
    }
    const child = spawn(launch.binary, [...launch.args, SQLITE_FINALIZE_ARGUMENT], {
      cwd: launch.cwd,
      env: { ...launch.env, [SQLITE_FINALIZE_ENV]: '1' },
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    let spawnError = null;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-4000);
    });
    const closed = await waitForChildProcessClose(child, timeoutMs);
    if (spawnError) {
      const error = new Error(`Failed to start OpenCode SQLite finalizer: ${spawnError.message}`, { cause: spawnError });
      error.code = 'OPENCHAMBER_OPENCODE_FINALIZE_SPAWN_FAILED';
      throw error;
    }
    if (!closed) {
      await terminateChildProcess(child, 500, { force: true });
      const error = new Error('OpenCode SQLite finalizer timed out');
      error.code = 'OPENCHAMBER_OPENCODE_FINALIZE_TIMEOUT';
      throw error;
    }
    if (child.exitCode !== 0 || child.signalCode !== null) {
      const detail = stderr.trim();
      throw new Error(`OpenCode SQLite finalizer exited with ${child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`}${detail ? `: ${detail}` : ''}`);
    }
  };

  const withShutdownPhase = (value, phase) => {
    const error = value instanceof Error ? value : new Error(String(value));
    error.openChamberShutdownPhase = phase;
    return error;
  };

  const getManagedOpenCodeProcessInfo = () => {
    const managedProcess = state.openCodeProcess || state.startingOpenCodeProcess;
    const managed = Boolean(
      (managedProcess || state.lastManagedOpenCodeLaunch)
      && !env.ENV_SKIP_OPENCODE_START
      && !state.isExternalOpenCode
    );
    return {
      managed,
      pid: managed && typeof managedProcess?.pid === 'number' ? managedProcess.pid : null,
      port: managed && managedProcess && typeof state.openCodePort === 'number' ? state.openCodePort : null,
    };
  };

  let managedShutdownPromise = null;
  const stopManagedOpenCode = (options = {}) => {
    if (managedShutdownPromise) return managedShutdownPromise;
    if (env.ENV_SKIP_OPENCODE_START || state.isExternalOpenCode) return Promise.resolve({ finalized: false });

    state.isShuttingDown = true;
    state.isOpenCodeReady = false;
    state.openCodeNotReadySince = Date.now();
    syncToHmrState();
    const processes = [...new Set([state.openCodeProcess, state.startingOpenCodeProcess].filter(Boolean))];
    const launch = processes.find((process) => process.launch)?.launch ?? state.lastManagedOpenCodeLaunch;
    const deadline = typeof options.deadline === 'number' && Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + MANAGED_SHUTDOWN_TIMEOUT_MS;
    const processDeadline = Math.min(deadline, Date.now() + MANAGED_PROCESS_TERMINATION_TIMEOUT_MS);
    managedShutdownPromise = Promise.allSettled(processes.map((serverInstance) => serverInstance.close({ deadline: processDeadline, force: true })))
      .then((results) => {
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw withShutdownPhase(failed.reason, 'termination');
        return launch?.sqliteFinalizer === true
          ? finalizeManagedOpenCodeDatabase(launch, Math.max(0, deadline - Date.now()))
              .then(() => ({ finalized: true }))
              .catch((error) => { throw withShutdownPhase(error, 'finalization'); })
          : { finalized: false };
      })
      .then((result) => {
        state.openCodeProcess = null;
        state.startingOpenCodeProcess = null;
        syncToHmrState();
        return result;
      });
    return managedShutdownPromise;
  };

  const formatCapturedOutput = ({ stdout, stderr }) => {
    const parts = [];
    if (stdout.trim()) {
      parts.push(`stdout:\n${stdout.trim()}`);
    }
    if (stderr.trim()) {
      parts.push(`stderr:\n${stderr.trim()}`);
    }
    return parts.length > 0 ? parts.join('\n\n') : 'No stdout/stderr captured';
  };

  const createManagedOpenCodeServerProcess = async ({ hostname, port, timeout, cwd, env: processEnv, shellEnvKeysCount = 0 }) => {
    assertNotShuttingDown();
    let binary = (process.env.OPENCODE_BINARY || 'opencode').trim() || 'opencode';
    const sourceBinary = binary;
    let launchArgs = [];
    let launchWrapperType = null;

    if (process.platform === 'win32' && state.useWslForOpencode) {
      throw new Error('Launching OpenCode through WSL is no longer supported. Install OpenCode natively on Windows and configure opencode.cmd or opencode.exe.');
    }

    if (process.platform === 'win32' && !state.useWslForOpencode) {
      const launchSpec = resolveManagedOpenCodeLaunchSpec(binary);
      if (launchSpec?.binary) {
        if (launchSpec.wrapperType) {
          console.log(`Launching OpenCode via ${launchSpec.wrapperType}: ${launchSpec.binary}`);
        }
        launchWrapperType = launchSpec.wrapperType || null;
        binary = launchSpec.binary;
        launchArgs = Array.isArray(launchSpec.args) ? launchSpec.args : [];
      }
    }
    const args = [...launchArgs, 'serve', '--hostname', hostname, '--port', String(port)];

    const pathValue = typeof processEnv?.PATH === 'string' ? processEnv.PATH : '';
    const pathEntryCount = pathValue ? pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean).length : 0;
    state.lastOpenCodeLaunchDiagnostics = {
      launchedAt: new Date().toISOString(),
      sourceBinary,
      binary,
      args,
      cwd,
      hostname,
      port,
      wrapperType: launchWrapperType,
      pathEntryCount,
      hasShellEnv: shellEnvKeysCount > 0,
      shellEnvKeysCount,
    };
    console.log('[OpenCode] Launching managed server', state.lastOpenCodeLaunchDiagnostics);

    const child = spawn(binary, args, {
      cwd,
      env: processEnv,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let closePromise = null;
    const serverInstance = {
      url: null,
      pid: child.pid || null,
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      launch: {
        binary,
        args: [...launchArgs],
        cwd,
        env: { ...processEnv },
        sqliteFinalizer: supportsOpenCodeSqliteFinalizer(sourceBinary),
      },
      close(options) {
        if (options?.force === true) {
          return closeManagedOpenCodeChild(child, options);
        }
        if (!closePromise) {
          closePromise = closeManagedOpenCodeChild(child, options);
        }
        return closePromise;
      },
    };
    state.lastManagedOpenCodeLaunch = serverInstance.launch;
    state.startingOpenCodeProcess = serverInstance;

    // Register immediately after spawn, not after readiness, so shutdown and
    // the next-run orphan reaper own a child that is still starting up.
    registerManagedProcess({
      pid: child.pid,
      ownerPid: process.pid,
      port,
      binary,
      runtime: process.env.OPENCHAMBER_RUNTIME || 'web',
    });

    try {
      const url = await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let done = false;
        const finish = (handler, value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          child.stdout?.off('data', onStdout);
          child.stderr?.off('data', onStderr);
          child.off('exit', onExit);
          child.off('error', onError);
          handler(value);
        };

        const onStdout = (chunk) => {
          stdout += chunk.toString();
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (!line.startsWith('opencode server listening')) continue;
            const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (!match) {
              finish(reject, new Error(`Failed to parse server url from output: ${line}`));
              return;
            }
            finish(resolve, match[1]);
            return;
          }
        };

        const onStderr = (chunk) => {
          stderr += chunk.toString();
        };

        const onExit = (code, signal) => {
          const reason = signal ? `signal ${signal}` : `code ${code}`;
          const appBundleHint = process.platform === 'darwin' && /\/OpenCode\.app\/Contents\/MacOS\/(?:OpenCode|opencode-cli)$/i.test(binary)
            ? ' The configured binary appears to point at the macOS desktop app bundle; OpenChamber needs the standalone opencode CLI.'
            : '';
          finish(reject, new Error(`OpenCode process exited before serving with ${reason}. Binary used: ${binary}.${appBundleHint} ${formatCapturedOutput({ stdout, stderr })}`));
        };

        const onError = (error) => {
          finish(reject, error);
        };

        const timer = setTimeout(() => {
          finish(reject, new Error(`Timeout waiting for OpenCode to start after ${timeout}ms`));
        }, timeout);

        child.stdout?.on('data', onStdout);
        child.stderr?.on('data', onStderr);
        child.on('exit', onExit);
        child.on('error', onError);
      });

      serverInstance.url = url;
      return serverInstance;
    } catch (error) {
      await serverInstance.close().catch(() => {});
      if (state.startingOpenCodeProcess === serverInstance) {
        state.startingOpenCodeProcess = null;
      }
      throw error;
    }
  };

  const resolveManagedOpenCodePort = async (requestedPort, hostname = '127.0.0.1') => {
    if (typeof requestedPort === 'number' && Number.isFinite(requestedPort) && requestedPort > 0) {
      return requestedPort;
    }

    return await new Promise((resolve, reject) => {
      const server = net.createServer();
      const cleanup = () => {
        server.removeAllListeners('error');
        server.removeAllListeners('listening');
      };

      server.once('error', (error) => {
        cleanup();
        reject(error);
      });

      server.once('listening', () => {
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        server.close(() => {
          cleanup();
          if (port > 0) {
            resolve(port);
            return;
          }
          reject(new Error('Failed to allocate OpenCode port'));
        });
      });

      server.listen(0, hostname);
    });
  };

  const isOpenCodeProcessHealthy = async () => {
    if (!state.openCodeProcess || !state.openCodePort) {
      return false;
    }

    try {
      const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
      });
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const probeExternalOpenCode = async (port, origin) => {
    if (!port || port <= 0) {
      return false;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const base = origin ?? `http://127.0.0.1:${port}`;
      const response = await fetch(`${base}${OPENCODE_HEALTH_PATH}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) return false;
      const body = await response.json().catch(() => null);
      return body?.healthy === true;
    } catch {
      return false;
    }
  };

  const waitForOpenCodePort = async (timeoutMs = 15000) => {
    if (state.openCodePort !== null) {
      return state.openCodePort;
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (state.openCodePort !== null) {
        return state.openCodePort;
      }
    }

    throw new Error('Timed out waiting for OpenCode port');
  };

  const START_OPEN_CODE_MAX_ATTEMPTS = 2;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startOpenCodeOnce = async (attempt) => {
    assertNotShuttingDown();
    const attemptStartedAt = performance.now();
    let phaseStartedAt = attemptStartedAt;
    recordStartupPerformance('opencode.attempt.start', { attempt });
    const desiredPort = env.ENV_CONFIGURED_OPENCODE_PORT ?? 0;
    const spawnPort = await resolveManagedOpenCodePort(desiredPort, env.ENV_CONFIGURED_OPENCODE_HOSTNAME);
    assertNotShuttingDown();
    console.log(
      desiredPort > 0
        ? `Starting OpenCode on requested port ${desiredPort}...`
        : `Starting OpenCode on allocated port ${spawnPort}...`
    );

    await applyOpencodeBinaryFromSettings({ strict: true });
    assertNotShuttingDown();
    ensureOpencodeCliEnv();
    recordStartupPerformance('opencode.binary.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();
    const openCodePassword = await ensureLocalOpenCodeServerPassword({ rotateManaged: true });
    assertNotShuttingDown();
    let envPath = process.env.PATH;
    if (typeof buildManagedOpenCodePath === 'function') {
      envPath = buildManagedOpenCodePath();
    } else if (typeof buildAugmentedPath === 'function') {
      envPath = buildAugmentedPath();
    }
    const shellEnv = typeof getManagedOpenCodeShellEnvSnapshot === 'function'
      ? getManagedOpenCodeShellEnvSnapshot() || {}
      : {};
    const managedOpenCodeEnv = await getManagedOpenCodeEnv();
    assertNotShuttingDown();
    recordStartupPerformance('opencode.environment.ready', {
      attempt,
      durationMs: performance.now() - phaseStartedAt,
      totalDurationMs: performance.now() - attemptStartedAt,
    });
    phaseStartedAt = performance.now();

    try {
      const serverInstance = await createManagedOpenCodeServerProcess({
        hostname: env.ENV_CONFIGURED_OPENCODE_HOSTNAME,
        port: spawnPort,
        timeout: 30000,
        cwd: state.openCodeWorkingDirectory,
        shellEnvKeysCount: Object.keys(shellEnv).length,
        env: stripAppImageArgv0Leak(applyProviderEnvAliases({
          ...shellEnv,
          ...process.env,
          ...managedOpenCodeEnv,
          PATH: envPath,
          OPENCODE_SERVER_PASSWORD: openCodePassword,
        })),
      });
      assertNotShuttingDown();

      if (!serverInstance || !serverInstance.url) {
        throw new Error('OpenCode server started but URL is missing');
      }
      recordStartupPerformance('opencode.process.ready', {
        attempt,
        durationMs: performance.now() - phaseStartedAt,
        totalDurationMs: performance.now() - attemptStartedAt,
      });
      phaseStartedAt = performance.now();

      const url = new URL(serverInstance.url);
      const port = parseInt(url.port, 10);
      const prefix = normalizeApiPrefix(url.pathname);

      if (await waitForReady(serverInstance.url, 10000)) {
        assertNotShuttingDown();
        setOpenCodePort(port);
        setDetectedOpenCodeApiPrefix(prefix);

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;

        recordStartupPerformance('opencode.health.ready', {
          attempt,
          durationMs: performance.now() - phaseStartedAt,
          totalDurationMs: performance.now() - attemptStartedAt,
          outcome: 'ready',
        });

        return serverInstance;
      }

      try {
        await serverInstance.close();
      } catch {
      }
      throw new Error('Server started but health check failed (timeout)');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastOpenCodeError = message;
      state.openCodePort = null;
      syncToHmrState();
      recordStartupPerformance('opencode.attempt.error', {
        attempt,
        totalDurationMs: performance.now() - attemptStartedAt,
        outcome: 'error',
      });
      console.error(`Failed to start OpenCode: ${message}`);
      throw error;
    }
  };

  const startOpenCode = async () => {
    assertNotShuttingDown();
    let lastError = null;
    for (let attempt = 1; attempt <= START_OPEN_CODE_MAX_ATTEMPTS; attempt += 1) {
      try {
        const serverInstance = await startOpenCodeOnce(attempt);
        assertNotShuttingDown();
        state.openCodeProcess = serverInstance;
        state.startingOpenCodeProcess = null;
        syncToHmrState();
        return serverInstance;
      } catch (error) {
        lastError = error;
        if (state.startingOpenCodeProcess) {
          await state.startingOpenCodeProcess.close().catch(() => {});
          state.startingOpenCodeProcess = null;
        }
        if (state.isShuttingDown || error?.code === 'OPENCHAMBER_SHUTTING_DOWN') {
          break;
        }
        if (error?.code === 'OPENCODE_BINARY_INVALID') {
          break;
        }
        if (attempt >= START_OPEN_CODE_MAX_ATTEMPTS) {
          break;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[OpenCode] Managed server startup failed on attempt ${attempt}/${START_OPEN_CODE_MAX_ATTEMPTS}; retrying: ${message}`);
        state.openCodePort = null;
        state.isOpenCodeReady = false;
        state.openCodeNotReadySince = Date.now();
        syncToHmrState();
        await delay(750 * attempt);
      }
    }

    throw lastError;
  };

  const restartOpenCode = async () => {
    if (state.isShuttingDown) return;
    if (state.currentRestartPromise) {
      await state.currentRestartPromise;
      return;
    }

    state.currentRestartPromise = (async () => {
      state.isRestartingOpenCode = true;
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.log('Restarting OpenCode process...');

      if (state.isExternalOpenCode) {
        console.log('Re-probing external OpenCode server...');
        const probePort = state.openCodePort || env.ENV_CONFIGURED_OPENCODE_PORT || 4096;
        const probeOrigin = state.openCodeBaseUrl ?? env.ENV_CONFIGURED_OPENCODE_HOST?.origin;
        const healthy = await probeExternalOpenCode(probePort, probeOrigin);
        if (healthy) {
          console.log(`External OpenCode server on port ${probePort} is healthy`);
          setOpenCodePort(probePort);
          state.isOpenCodeReady = true;
          state.lastOpenCodeError = null;
          state.openCodeNotReadySince = 0;
          syncToHmrState();
        } else {
          state.lastOpenCodeError = `External OpenCode server on port ${probePort} is not responding`;
          console.error(state.lastOpenCodeError);
          throw new Error(state.lastOpenCodeError);
        }

        if (state.expressApp) {
          setupProxy(state.expressApp);
          ensureOpenCodeApiPrefix();
        }
        return;
      }

      const portToKill = state.openCodePort;

      if (state.openCodeProcess) {
        console.log('Stopping existing OpenCode process...');
        try {
          await state.openCodeProcess.close();
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        state.openCodeProcess = null;
        syncToHmrState();
      }

      killProcessOnPort(portToKill);
      if (!(await waitForPortRelease(portToKill, 5000))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released`);
      }

      if (env.ENV_CONFIGURED_OPENCODE_PORT) {
        console.log(`Using OpenCode port from environment: ${env.ENV_CONFIGURED_OPENCODE_PORT}`);
        setOpenCodePort(env.ENV_CONFIGURED_OPENCODE_PORT);
      } else {
        state.openCodePort = null;
        syncToHmrState();
      }

      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      if (state.openCodeApiDetectionTimer) {
        clearTimeout(state.openCodeApiDetectionTimer);
        state.openCodeApiDetectionTimer = null;
      }

      state.lastOpenCodeError = null;
      await startOpenCode();

      if (state.expressApp) {
        setupProxy(state.expressApp);
        ensureOpenCodeApiPrefix();
      }

      // The restart may have landed on a NEW port (the old one can remain
      // occupied by an orphaned process, e.g. Windows killProcessOnPort is a
      // no-op). Upstream event readers pinned to the old process would keep
      // the UI silent forever, so rebind them to the current port. Best
      // effort: a failure here must not fail the restart itself.
      try {
        onOpenCodeRestarted?.();
      } catch (error) {
        console.warn('Failed to rebind event stream after OpenCode restart:', error?.message ?? error);
      }
    })();

    try {
      await state.currentRestartPromise;
    } catch (error) {
      console.error(`Failed to restart OpenCode: ${error.message}`);
      state.lastOpenCodeError = error.message;
      if (!env.ENV_CONFIGURED_OPENCODE_PORT) {
        state.openCodePort = null;
        syncToHmrState();
      }
      state.openCodeApiPrefixDetected = true;
      state.openCodeApiPrefix = '';
      throw error;
    } finally {
      state.currentRestartPromise = null;
      state.isRestartingOpenCode = false;
    }
  };

  const waitForOpenCodeReady = async (timeoutMs = 20000, intervalMs = 400) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    let lastError = null;

    while (Date.now() < deadline) {
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
        const response = await fetch(buildOpenCodeUrl(OPENCODE_HEALTH_PATH, ''), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
        clearTimeout(timeout);
        timeout = null;

        if (!response.ok) {
          lastError = new Error(`OpenCode health endpoint responded with status ${response.status}`);
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        const body = await response.json().catch(() => null);
        if (body?.healthy !== true) {
          lastError = new Error('OpenCode health endpoint returned unhealthy response');
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          continue;
        }

        state.isOpenCodeReady = true;
        state.lastOpenCodeError = null;
        return;
      } catch (error) {
        lastError = error;
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    if (lastError) {
      state.lastOpenCodeError = lastError.message || String(lastError);
      throw lastError;
    }

    const timeoutError = new Error('Timed out waiting for OpenCode to become ready');
    state.lastOpenCodeError = timeoutError.message;
    throw timeoutError;
  };

  const waitForAgentPresence = async (agentName, timeoutMs = 15000, intervalMs = 300) => {
    if (!state.openCodePort) {
      throw new Error('OpenCode port is not available');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(buildOpenCodeUrl('/agent'), {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        });

        if (response.ok) {
          const agents = await response.json();
          if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentName)) {
            return;
          }
        }
      } catch {
      }

      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Agent "${agentName}" not available after OpenCode restart`);
  };

  const refreshOpenCodeAfterConfigChange = async (reason, options = {}) => {
    const { agentName } = options;

    console.log(`Refreshing OpenCode after ${reason}`);
    clearResolvedOpenCodeBinary();
    await applyOpencodeBinaryFromSettings();

    await restartOpenCode();

    // A managed OpenCode process is restarted (and thus re-reads config from
    // disk) by restartOpenCode(). An external OpenCode server is NOT owned by
    // OpenChamber: restartOpenCode() only re-probes its health, so the freshly
    // written config is on disk but the running server keeps serving its old,
    // startup-cached config until the user restarts it themselves. Report this
    // honestly so callers don't claim the change is live.
    const external = state.isExternalOpenCode === true;

    try {
      await waitForOpenCodeReady();
      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;

      // Waiting for the agent to appear only makes sense when we actually
      // reloaded config. An external server will never surface it here.
      if (agentName && !external) {
        await waitForAgentPresence(agentName);
      }

      state.isOpenCodeReady = true;
      state.openCodeNotReadySince = 0;
    } catch (error) {
      state.isOpenCodeReady = false;
      state.openCodeNotReadySince = Date.now();
      console.error(`Failed to refresh OpenCode after ${reason}:`, error.message);
      throw error;
    }

    return { reloaded: !external, external };
  };

  const bootstrapOpenCodeAtStartup = async () => {
    const bootstrapStartedAt = performance.now();
    let bootstrapError = null;
    recordStartupPerformance('opencode.bootstrap.start');
    try {
      // Before doing anything, reap any OpenCode process WE spawned in a prior
      // run that was orphaned by a crash/hard-exit. Verified + scoped to our own
      // pids, so it never touches a live instance's or the user's own server.
      try {
        const orphanReapStartedAt = performance.now();
        const { reaped } = await reapManagedOrphanedProcesses({ log: (msg) => console.log(msg) });
        recordStartupPerformance('opencode.orphan-reap.ready', {
          durationMs: performance.now() - orphanReapStartedAt,
          totalDurationMs: performance.now() - bootstrapStartedAt,
        });
        if (reaped > 0) console.log(`[lifecycle] startup reaped ${reaped} orphaned OpenCode process(es)`);
      } catch (error) {
        console.warn('[lifecycle] orphan reap failed:', error?.message ?? error);
      }

      syncFromHmrState();
      assertNotShuttingDown();
      const existingProcessHealthy = await isOpenCodeProcessHealthy();
      assertNotShuttingDown();
      if (existingProcessHealthy) {
        console.log(`[HMR] Reusing existing OpenCode process on port ${state.openCodePort}`);
      } else if (env.ENV_SKIP_OPENCODE_START && env.ENV_EFFECTIVE_PORT) {
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Using external OpenCode server at ${label} (skip-start mode)`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else if (env.ENV_EFFECTIVE_PORT && await probeExternalOpenCode(env.ENV_EFFECTIVE_PORT, env.ENV_CONFIGURED_OPENCODE_HOST?.origin)) {
        assertNotShuttingDown();
        const label = env.ENV_CONFIGURED_OPENCODE_HOST ? env.ENV_CONFIGURED_OPENCODE_HOST.origin : `http://localhost:${env.ENV_EFFECTIVE_PORT}`;
        console.log(`Auto-detected existing OpenCode server at ${label}`);
        state.openCodeBaseUrl = env.ENV_CONFIGURED_OPENCODE_HOST?.origin ?? null;
        setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        state.isOpenCodeReady = true;
        state.isExternalOpenCode = true;
        state.lastOpenCodeError = null;
        state.openCodeNotReadySince = 0;
        syncToHmrState();
      } else {
        // We never auto-attach to an arbitrary pre-existing OpenCode instance.
        // Attaching to an external server requires explicit opt-in via env
        // (OPENCODE_HOST / OPENCODE_PORT / OPENCODE_SKIP_START), handled by the
        // branches above. Without that opt-in we always start our OWN managed
        // instance on a freshly-allocated port. A blind probe of the default
        // port 4096 used to hijack a user's separately-running OpenCode (e.g.
        // the OpenCode desktop app), coupling our lifecycle to theirs and
        // breaking init against an unexpected server version/config.
        if (env.ENV_EFFECTIVE_PORT) {
          console.log(`Using OpenCode port from environment: ${env.ENV_EFFECTIVE_PORT}`);
          setOpenCodePort(env.ENV_EFFECTIVE_PORT);
        } else {
          state.openCodePort = null;
          syncToHmrState();
        }

        state.lastOpenCodeError = null;
        await startOpenCode();
      }
      await waitForOpenCodePort();
      try {
        await waitForOpenCodeReady();
      } catch (error) {
        bootstrapError = error;
        console.error(`OpenCode readiness check failed: ${error.message}`);
      }
    } catch (error) {
      bootstrapError = error;
      console.error(`Failed to start OpenCode: ${error.message}`);
      console.log('Continuing without OpenCode integration...');
      state.lastOpenCodeError = error.message;
    }
    recordStartupPerformance(
      bootstrapError ? 'opencode.bootstrap.error' : 'opencode.bootstrap.ready',
      {
        totalDurationMs: performance.now() - bootstrapStartedAt,
        outcome: bootstrapError ? 'error' : 'ready',
      },
    );
    if (!bootstrapError && !state.isShuttingDown) {
      void warmOpenCodeDirectories();
    }
  };

  // OpenCode initializes each project directory lazily on its first
  // directory-scoped request, and that initialization takes seconds on large
  // session stores. Without warming, the user's first session open pays it
  // interactively (the chat waits on the message fetch until the directory
  // finishes initializing). Warm the most recently used directories right
  // after readiness so the work overlaps UI startup instead. Sequential and
  // best-effort: a failed or slow directory never blocks the others for long,
  // and a restart invalidates the pass via the port/readiness guard.
  const warmOpenCodeDirectories = async () => {
    let directories = [];
    try {
      directories = await getWarmupDirectories();
    } catch {
      return;
    }
    if (!Array.isArray(directories) || directories.length === 0) return;

    const warmedPort = state.openCodePort;
    for (const directory of directories.slice(0, WARMUP_DIRECTORY_LIMIT)) {
      if (state.isShuttingDown) return;
      if (typeof directory !== 'string' || !directory) continue;
      if (!state.isOpenCodeReady || state.openCodePort !== warmedPort) return;
      let timeout = null;
      try {
        const controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), WARMUP_REQUEST_TIMEOUT_MS);
        const url = `${buildOpenCodeUrl('/session/status', '')}?directory=${encodeURIComponent(directory)}`;
        await fetch(url, {
          method: 'GET',
          headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
          signal: controller.signal,
        });
      } catch {
        // Best-effort — the directory stays lazy and the UI's own request warms it.
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };

  /**
   * Perform an immediate (one-shot) health check and restart OpenCode if it's
   * not healthy.  Callers on the SSE / WS proxy path use this to trigger
   * recovery without waiting for the next periodic interval (up to 15 s).
   *
   * Skips restart when sessions are actively busy — a busy server under
   * concurrent load can fail the health check timeout without actually
   * being dead (the health endpoint competes with LLM work).
   * Forces restart if sessions stay "busy" and the server stays unhealthy
   * for over 2 minutes (staleness guard against stuck session state).
   */
  const STALE_BUSY_GRACE_MS = 2 * 60 * 1000;
  let lastUnhealthyWithBusySessionsAt = 0;
  let consecutiveHealthFailures = 0;
  let lastCountedHealthFailureAt = 0;
  let healthProbePromise = null;
  let healthCheckCyclePromise = null;
  let lastHealthProbeResult = null;
  let healthFailureCountIntervalMs = 15_000;

  const resetHealthFailureState = () => {
    consecutiveHealthFailures = 0;
    lastUnhealthyWithBusySessionsAt = 0;
    lastCountedHealthFailureAt = 0;
  };

  const probeOpenCodeHealth = async () => {
    const checkedAt = now();
    if (lastHealthProbeResult && checkedAt - lastHealthProbeResult.at < HEALTH_CHECK_RESULT_CACHE_MS) {
      return lastHealthProbeResult.healthy;
    }

    if (healthProbePromise) {
      return healthProbePromise;
    }

    healthProbePromise = isOpenCodeProcessHealthy()
      .then((healthy) => {
        lastHealthProbeResult = { at: now(), healthy };
        return healthy;
      })
      .finally(() => {
        healthProbePromise = null;
      });

    return healthProbePromise;
  };

  const shouldSkipRestartForBusySessions = () => {
    const activeCount = getActiveSessionCount();
    if (activeCount === 0) {
      lastUnhealthyWithBusySessionsAt = 0;
      return false;
    }

    const checkedAt = now();
    if (!lastUnhealthyWithBusySessionsAt) {
      lastUnhealthyWithBusySessionsAt = checkedAt;
      return true;
    }

    if (checkedAt - lastUnhealthyWithBusySessionsAt >= STALE_BUSY_GRACE_MS) {
      console.warn(
        `[lifecycle] OpenCode unhealthy with ${activeCount} busy session(s) for > 2 min — forcing restart`
      );
      lastUnhealthyWithBusySessionsAt = 0;
      return false;
    }

    return true;
  };

  const runHealthCheckCycle = async (source) => {
    if (!state.openCodeProcess || state.isShuttingDown || state.isRestartingOpenCode) return;
    if (healthCheckCyclePromise) return healthCheckCyclePromise;

    healthCheckCyclePromise = (async () => {
      const healthy = await probeOpenCodeHealth();
      if (!healthy) {
        if (!isManagedOpenCodeProcessAlive()) {
          console.log(`[lifecycle] ${source} health check: OpenCode process exited, restarting...`);
          consecutiveHealthFailures = 0;
          lastHealthProbeResult = null;
          await restartOpenCode();
          return;
        }
        const checkedAt = now();
        if (lastCountedHealthFailureAt && checkedAt - lastCountedHealthFailureAt < healthFailureCountIntervalMs) {
          return;
        }
        lastCountedHealthFailureAt = checkedAt;
        consecutiveHealthFailures += 1;
        console.warn(
          `[lifecycle] ${source} health check failed (${consecutiveHealthFailures}/${HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES})`
        );
        if (consecutiveHealthFailures < HEALTH_CHECK_MAX_CONSECUTIVE_FAILURES) return;
        if (shouldSkipRestartForBusySessions()) return;
        console.log(`[lifecycle] ${source} health check failure threshold reached, restarting OpenCode...`);
        consecutiveHealthFailures = 0;
        lastHealthProbeResult = null;
        await restartOpenCode();
      } else {
        resetHealthFailureState();
      }
    })().finally(() => {
      healthCheckCyclePromise = null;
    });

    return healthCheckCyclePromise;
  };

  const triggerHealthCheck = async () => {
    try {
      await runHealthCheckCycle('immediate');
    } catch (error) {
      console.error(`[lifecycle] immediate health check error: ${error.message}`);
    }
  };

  const startHealthMonitoring = (healthCheckIntervalMs) => {
    if (state.isShuttingDown) return;
    if (state.healthCheckInterval) {
      clearInterval(state.healthCheckInterval);
    }

    const effectiveIntervalMs = HEALTH_CHECK_INTERVAL_OVERRIDE_MS || healthCheckIntervalMs;
    healthFailureCountIntervalMs = effectiveIntervalMs;

    state.healthCheckInterval = setInterval(async () => {
      try {
        await runHealthCheckCycle('periodic');
      } catch (error) {
        console.error(`Health check error: ${error.message}`);
      }
    }, effectiveIntervalMs);
  };

  return {
    killProcessOnPort,
    startOpenCode,
    restartOpenCode,
    waitForOpenCodeReady,
    waitForAgentPresence,
    refreshOpenCodeAfterConfigChange,
    bootstrapOpenCodeAtStartup,
    getManagedOpenCodeProcessInfo,
    stopManagedOpenCode,
    startHealthMonitoring,
    triggerHealthCheck,
    waitForPortRelease,
  };
};
