import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createStartupSingleFlight } from './startup-single-flight.mjs';

// Runs the real openMainWindow body without importing Electron or a server.
const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
const start = main.indexOf('const openMainWindow = async () => {');
const openMainWindowSource = main.slice(start, main.indexOf('\n};', start) + 4);

const loadOpenMainWindow = (state) => {
  const calls = { resolveInitialUrl: 0, activated: 0 };
  const initialStartup = Promise.withResolvers();
  const context = {
    state,
    initialStartup,
    LOCAL_HOST_ID: 'local',
    readDesktopHostsConfig: () => ({ defaultHostId: 'local', hosts: [] }),
    shouldUsePackagedUi: () => false,
    resolveStoredClientTokenForUrl: () => '',
    sanitizeRuntimeRequestHeaders: (headers) => headers,
    resolveInitialUrl: async () => {
      calls.resolveInitialUrl += 1;
      return { initialUrl: 'https://remote.example.test', localOrigin: null };
    },
    activateMainWindow: async () => {
      calls.activated += 1;
      state.mainWindow = { isDestroyed: () => false };
      return state.mainWindow;
    },
  };
  const openMainWindow = runInNewContext(`${openMainWindowSource}; openMainWindow`, context);
  return { calls, initialStartup, openMainWindow };
};

const backgroundState = () => ({
  startupResolved: false,
  mainWindow: null,
  sidecarUrl: 'http://127.0.0.1:3000',
  localOrigin: 'http://127.0.0.1:3000',
  unreachableHosts: new Set(),
});

test('windows asked for during a background start wait for it and resolve nothing themselves', async () => {
  const state = backgroundState();
  const { calls, initialStartup, openMainWindow } = loadOpenMainWindow(state);

  const opens = [openMainWindow(), openMainWindow()];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.resolveInitialUrl, 0);
  assert.equal(calls.activated, 0);

  state.startupResolved = true;
  initialStartup.resolve();
  const [first, second] = await Promise.all(opens);

  assert.equal(calls.resolveInitialUrl, 0);
  assert.equal(calls.activated, 1);
  assert.equal(first, second);
});

test('a window that a foreground startup already opened is the one returned', async () => {
  const state = backgroundState();
  const { calls, initialStartup, openMainWindow } = loadOpenMainWindow(state);

  const open = openMainWindow();
  state.startupResolved = true;
  state.mainWindow = { isDestroyed: () => false };
  initialStartup.resolve();

  assert.equal(await open, state.mainWindow);
  assert.equal(calls.activated, 0);
});

test('a serverless background start still probes again when the window opens', async () => {
  const state = backgroundState();
  const { calls, initialStartup, openMainWindow } = loadOpenMainWindow(state);

  initialStartup.resolve();
  await openMainWindow();

  assert.equal(calls.resolveInitialUrl, 1);
  assert.equal(calls.activated, 1);
});

test('shares one startup promise across concurrent callers', async () => {
  let calls = 0;
  let completeStartup;
  const start = createStartupSingleFlight(() => {
    calls += 1;
    return new Promise((resolve) => {
      completeStartup = resolve;
    });
  });

  const first = start();
  const second = start();
  assert.strictEqual(second, first);
  assert.equal(calls, 1);

  completeStartup('ready');
  assert.equal(await first, 'ready');
  assert.strictEqual(start(), first);
  assert.equal(calls, 1);
});

test('retains a rejected startup promise without retrying', async () => {
  const failure = new Error('startup failed');
  let calls = 0;
  const start = createStartupSingleFlight(async () => {
    calls += 1;
    throw failure;
  });

  const first = start();
  await assert.rejects(first, failure);
  const second = start();
  assert.strictEqual(second, first);
  await assert.rejects(second, failure);
  assert.equal(calls, 1);
});
