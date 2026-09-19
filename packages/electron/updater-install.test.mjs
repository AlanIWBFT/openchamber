import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createUpdateInstaller } from './updater-install.mjs';

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
    flushStorage: () => {},
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

test('async package installation retains exit ownership through the prompt and restarts after success', async () => {
  const packageInstalled = deferred();
  const storageFlushed = deferred();
  const f = fixture({
    installPackage: () => { f.calls.push('package'); return packageInstalled.promise; },
    flushStorage: () => { f.calls.push('flush'); return storageFlushed.promise; },
  });
  // The main process also logs background updater errors independently of installation.
  f.autoUpdater.on('error', () => {});
  const result = f.install();
  let completed = false;
  void result.then(() => { completed = true; });
  await tick();
  assert.deepEqual(f.calls, ['shutdown']);
  f.cleanup.resolve();
  await tick();
  f.autoUpdater.emit('error', new Error('background update check failed'));
  await new Promise((done) => setTimeout(done, 30));
  assert.equal(completed, false);
  assert.equal(f.state.updateInstallPending, true);
  assert.equal(f.state.allowWindowClose, false);
  assert.deepEqual(f.calls, ['shutdown', 'package']);
  packageInstalled.resolve();
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'package', 'flush']);
  assert.equal(completed, false);
  assert.equal(f.state.updateInstallPending, true);
  assert.equal(f.state.allowWindowClose, false);
  assert.equal(f.install(), result);
  storageFlushed.resolve();
  await result;
  await f.restarted.promise;
  assert.deepEqual(f.calls, ['shutdown', 'package', 'flush', 'restart']);
  assert.equal(f.state.updateInstallPending, false);
  assert.equal(f.state.allowWindowClose, true);
});

test('a rejected package install keeps the local failure acknowledgement before restart', async () => {
  const storageFlushed = deferred();
  const f = fixture({
    installPackage: async () => { throw new Error('administrator cancelled'); },
    flushStorage: () => { f.calls.push('flush'); return storageFlushed.promise; },
  });
  const rejected = assert.rejects(f.install(), /administrator cancelled/);
  f.cleanup.resolve();
  await rejected;
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'failure']);
  assert.equal(f.state.allowWindowClose, false);
  f.acknowledged.resolve();
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'failure', 'flush']);
  assert.equal(f.state.allowWindowClose, false);
  assert.equal(f.state.quitInProgress, true);
  storageFlushed.resolve();
  await f.restarted.promise;
  assert.deepEqual(f.calls, ['shutdown', 'failure', 'flush', 'restart']);
});

test('native installer handoff waits for storage while retaining exit ownership', async () => {
  const storageFlushed = deferred();
  const f = fixture({ flushStorage: () => { f.calls.push('flush'); return storageFlushed.promise; } });
  const result = f.install();
  f.cleanup.resolve();
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'flush']);
  assert.equal(f.state.updateInstallPending, true);
  assert.equal(f.state.allowWindowClose, false);
  assert.equal(f.install(), result);
  storageFlushed.resolve();
  await result;
  assert.deepEqual(f.calls, ['shutdown', 'flush', 'install']);
});

test('an updater error during storage flush cancels handoff and flushes again after acknowledgement', async () => {
  const storageFlushed = deferred();
  const f = fixture({ flushStorage: () => { f.calls.push('flush'); return storageFlushed.promise; } });
  const rejected = assert.rejects(f.install(), /update failed/);
  f.cleanup.resolve();
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'flush']);
  f.autoUpdater.emit('error', new Error('update failed'));
  await rejected;
  await tick();
  assert.deepEqual(f.calls, ['shutdown', 'flush', 'failure']);
  storageFlushed.resolve();
  await tick();
  assert.equal(f.calls.includes('install'), false);
  assert.equal(f.state.allowWindowClose, false);
  f.acknowledged.resolve();
  await f.restarted.promise;
  assert.deepEqual(f.calls, ['shutdown', 'flush', 'failure', 'flush', 'restart']);
});

test('storage flush failure is logged without stranding a completed package install', async () => {
  const error = new Error('renderer closed');
  const warnings = [];
  const f = fixture({
    installPackage: async () => {},
    flushStorage: async () => { throw error; },
    log: { info() {}, error() {}, warn: (...args) => warnings.push(args) },
  });
  const result = f.install();
  f.cleanup.resolve();
  await result;
  await f.restarted.promise;
  assert.deepEqual(warnings, [['[electron] storage flush before update exit failed:', error]]);
  assert.equal(f.state.allowWindowClose, true);
  assert.equal(f.state.updateInstallPending, false);
});
