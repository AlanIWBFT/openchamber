import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createServerDependencyPreload,
  ServerDependencyPreloadEnvironmentError,
} from './server-dependency-preload.mjs';

test('shares one successful server dependency preload', async () => {
  let loads = 0;
  let captures = 0;
  const phases = [];
  const preload = createServerDependencyPreload({
    load: async () => { loads += 1; },
    capture: async (load) => {
      captures += 1;
      await load();
      return { accesses: [] };
    },
    recordPerformance: (phase) => phases.push(phase),
  });

  const first = preload.begin();
  const second = preload.begin();
  assert.strictEqual(second, first);
  await Promise.all([first, preload.wait()]);
  assert.equal(loads, 1);
  assert.equal(captures, 1);
  assert.deepEqual(phases, ['electron.server-preload.start', 'electron.server-preload.ready']);
});

test('bypasses the runtime guard after the shell environment is ready', async () => {
  let loads = 0;
  const preload = createServerDependencyPreload({
    load: async () => { loads += 1; },
    capture: async () => { throw new Error('capture should not run'); },
    isEnvironmentReady: () => true,
  });

  await preload.wait();
  assert.equal(loads, 1);
});

test('holds the runtime guard until the shell environment is ready', async () => {
  let markEnvironmentReady;
  const environmentReady = new Promise((resolve) => { markEnvironmentReady = resolve; });
  let markCaptureStarted;
  const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
  const preload = createServerDependencyPreload({
    load: async () => {},
    capture: async (load, options) => {
      await load();
      markCaptureStarted();
      await options.settle();
      return { accesses: [] };
    },
    waitForEnvironmentReady: () => environmentReady,
  });

  let settled = false;
  const result = preload.begin().then((value) => {
    settled = true;
    return value;
  });
  await captureStarted;
  await Promise.resolve();
  assert.equal(settled, false);

  markEnvironmentReady();
  assert.equal((await result).ok, true);
});

test('retains and reports a preload environment violation', async () => {
  const accesses = [{ operation: 'read', key: 'DEBUG', frame: 'dependency.js:1:1' }];
  const logged = [];
  const preload = createServerDependencyPreload({
    load: async () => {},
    capture: async () => ({ accesses }),
    logger: { error: (...args) => logged.push(args) },
  });

  const backgroundResult = await preload.begin();
  assert.equal(backgroundResult.ok, false);
  await assert.rejects(preload.wait(), (error) => {
    assert.ok(error instanceof ServerDependencyPreloadEnvironmentError);
    assert.equal(error.code, 'OPENCHAMBER_SERVER_PRELOAD_ENV_ACCESS');
    assert.deepEqual(error.accesses, accesses);
    return true;
  });
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0][1].accesses, accesses);
});
