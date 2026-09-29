import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createUpdateInstaller } from './updater-install.mjs';
import { createInjectedProxyEnvironment } from './windows-shell.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => new Promise((done) => setImmediate(done));
const fixture = (options = {}) => {
  const state = { allowWindowClose: false };
  const autoUpdater = new EventEmitter();
  const cleanup = deferred();
  const acknowledged = deferred();
  const restarted = deferred();
  const calls = [];
  autoUpdater.quitAndInstall = () => {
    assert.equal(state.allowWindowClose, true);
    assert.equal(state.installingUpdate, true);
    calls.push('install');
  };
  const install = createUpdateInstaller({
    state, autoUpdater,
    shutdown: () => { calls.push('shutdown'); return cleanup.promise; },
    showFailure: () => { calls.push('failure'); return acknowledged.promise; },
    restart: () => { calls.push('restart'); restarted.resolve(); },
    log: { info() {}, warn() {}, error() {} },
    installGraceMs: 10,
    ...options,
  });
  return { state, autoUpdater, cleanup, acknowledged, restarted, calls, install };
};

test('owns exit before cleanup and hands off only after cleanup, once', async () => {
  const f = fixture();
  const result = f.install();
  assert.equal(f.install(), result);
  assert.equal(f.state.updateInstallPending, true);
  assert.equal(f.state.quitInProgress, true);
  assert.equal(f.state.allowWindowClose, false);
  await tick();
  assert.deepEqual(f.calls, ['shutdown']);
  f.cleanup.resolve();
  await result;
  assert.deepEqual(f.calls, ['shutdown', 'install']);
  assert.equal(f.state.updateInstallPending, false);
  assert.equal(f.state.allowWindowClose, true);
  assert.equal(f.autoUpdater.listenerCount('error'), 0);
});

test('asynchronous installer failure restarts only after acknowledgement', async () => {
  const f = fixture({ installGraceMs: 1000 });
  const result = f.install();
  const rejected = assert.rejects(result, /signature/);
  f.cleanup.resolve();
  await tick();
  f.autoUpdater.emit('error', new Error('signature rejected'));
  await rejected;
  await tick();
  assert.equal(f.state.allowWindowClose, false);
  assert.equal(f.state.quitInProgress, true);
  assert.deepEqual(f.calls, ['shutdown', 'install', 'failure']);
  f.acknowledged.resolve();
  await f.restarted.promise;
  assert.deepEqual(f.calls, ['shutdown', 'install', 'failure', 'restart']);
  assert.equal(f.state.allowWindowClose, true);
});

test('an error during cleanup waits for cleanup and never invokes the installer', async () => {
  const f = fixture();
  const rejected = assert.rejects(f.install(), /failed/);
  f.autoUpdater.emit('error', new Error('update failed'));
  await rejected;
  await tick();
  assert.deepEqual(f.calls, ['shutdown']);
  f.cleanup.resolve();
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'failure']);
  f.acknowledged.resolve();
  await f.restarted.promise;
  assert.equal(f.calls.includes('install'), false);
});

test('retains the upstream outer shutdown bound before handing off', async () => {
  const f = fixture({ shutdownTimeoutMs: 10 });
  await f.install();
  assert.deepEqual(f.calls, ['shutdown', 'install']);
  f.cleanup.resolve();
});

test('installer inherits a cleaned proxy environment after shutdown or its timeout', async () => {
  for (const timedOut of [false, true]) {
    const env = { HTTPS_PROXY: 'http://system.test', NO_PROXY: 'localhost' };
    const injected = createInjectedProxyEnvironment(env);
    for (const [key, value] of Object.entries(env)) injected.remember(key, value);
    const f = fixture({ beforeInstall: () => injected.clear(), shutdownTimeoutMs: 10 });
    f.autoUpdater.quitAndInstall = () => {
      assert.deepEqual(env, {});
      f.calls.push('install');
    };
    const result = f.install();
    await tick();
    assert.equal(env.HTTPS_PROXY, 'http://system.test');
    if (!timedOut) f.cleanup.resolve();
    await result;
    assert.deepEqual(f.calls, ['shutdown', 'install']);
    f.cleanup.resolve();
  }
});

test('failure before installer handoff leaves proxy cleanup to the recovery restart', async () => {
  const env = { HTTPS_PROXY: 'http://system.test' };
  const injected = createInjectedProxyEnvironment(env);
  injected.remember('HTTPS_PROXY', env.HTTPS_PROXY);
  const restarted = deferred();
  let handoffs = 0;
  const f = fixture({
    beforeInstall: () => { handoffs++; injected.clear(); },
    restart: () => { injected.clear(); restarted.resolve(); },
  });
  const rejected = assert.rejects(f.install(), /failed/);
  f.autoUpdater.emit('error', new Error('update failed'));
  await rejected;
  assert.equal(env.HTTPS_PROXY, 'http://system.test');
  f.cleanup.resolve();
  f.acknowledged.resolve();
  await restarted.promise;
  assert.equal(handoffs, 0);
  assert.deepEqual(env, {});
});
