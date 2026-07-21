#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform === 'darwin';
const webRoot = path.join(repoRoot, 'packages/web');

function run(label, command, args, env = {}, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
  }).on('error', (error) => {
    console.error(`[dev:web:hmr] Failed to start ${label}:`, error);
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (useDetachedChildren && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
  }
}

function killWindowsProcessTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
  }
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    killWindowsProcessTree(child.pid);
    await waitForExit(child, 1000);
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
  }
}

const uiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5180';
const backendPort = process.env.OPENCHAMBER_HMR_API_PORT || '3902';
const hmrHost = process.env.OPENCHAMBER_HMR_HOST || '127.0.0.1';
const viteOnly = process.env.OPENCHAMBER_HMR_VITE_ONLY === '1';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForElectronApi() {
  const healthUrl = `http://127.0.0.1:${backendPort}/health`;
  const deadline = Date.now() + 30_000;

  console.log(`[dev:web:hmr] Waiting for Electron API: ${healthUrl}`);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        const health = await response.json();
        if (health?.runtime === 'desktop') {
          console.log('[dev:web:hmr] Electron API ready; starting Vite');
          return;
        }
      }
    } catch {
    }
    await wait(100);
  }

  throw new Error(`Electron API did not become ready at ${healthUrl}`);
}

function getLanAddresses() {
  const addresses = [];

  for (const networkAddresses of Object.values(os.networkInterfaces())) {
    for (const address of networkAddresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      addresses.push(address.address);
    }
  }

  return addresses;
}

if (viteOnly) {
  await waitForElectronApi();
}

const api = viteOnly
  ? null
  : run('api', 'bun', ['run', '--cwd', 'packages/web', 'dev:server:watch'], {
      OPENCHAMBER_PORT: backendPort,
      // Dev backends share the relay identity with the production instance; never
      // let them capture the machine's relay host on their own.
      OPENCHAMBER_RELAY_HOST: process.env.OPENCHAMBER_RELAY_HOST || 'off',
    });
const vite = run(
  'vite',
  'bun',
  ['x', 'vite', '--force', '--host', hmrHost, '--port', uiPort, '--strictPort'],
  {
    OPENCHAMBER_PORT: backendPort,
    OPENCHAMBER_DISABLE_PWA_DEV: '1',
  },
  { cwd: webRoot },
);

console.log(`[dev:web:hmr] UI with HMR: http://127.0.0.1:${uiPort}`);
if (hmrHost === '0.0.0.0' || hmrHost === '::') {
  const lanAddresses = getLanAddresses();
  if (lanAddresses.length > 0) {
    for (const address of lanAddresses) {
      console.log(`[dev:web:hmr] LAN/mobile UI: http://${address}:${uiPort}`);
    }
  } else {
    console.log('[dev:web:hmr] LAN/mobile UI: no LAN IPv4 address found');
  }
}
console.log(`[dev:web:hmr] API${viteOnly ? ' target (provided by Electron)' : ''}: http://127.0.0.1:${backendPort}`);
console.log('[dev:web:hmr] IMPORTANT: open UI URL above for HMR; backend URL has no HMR');

let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(api), stopChildTree(vite)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) return;

    if (code !== 0 || signal) {
      console.error(`[dev:web:hmr] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

api?.on('exit', onChildExit('api'));
vite.on('exit', onChildExit('vite'));

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
