import assert from 'node:assert/strict';
import test from 'node:test';

import { capturePreloadEnvironmentAccesses } from '@openchamber/web/server/preload-env-guard.js';

test('captures reads, checks, enumeration, and writes in the guarded import context', async () => {
  const processLike = { env: { PRESENT: '1' } };
  const originalEnv = processLike.env;
  const { accesses } = await capturePreloadEnvironmentAccesses(() => {
    void processLike.env.PRESENT;
    void ('MISSING' in processLike.env);
    void Object.keys(processLike.env);
    processLike.env.WRITTEN = '1';
  }, { processLike, settle: null });

  assert.strictEqual(processLike.env, originalEnv);
  assert.ok(accesses.some((entry) => entry.operation === 'read' && entry.key === 'PRESENT'));
  assert.ok(accesses.some((entry) => entry.operation === 'check' && entry.key === 'MISSING'));
  assert.ok(accesses.some((entry) => entry.operation === 'enumerate' && entry.frame.includes('server-preload-env.test.mjs')));
  assert.ok(accesses.some((entry) => entry.operation === 'write' && entry.key === 'WRITTEN'));
});

test('propagates the guard through dynamic ESM evaluation', async () => {
  const { accesses } = await capturePreloadEnvironmentAccesses(
    () => import('./fixtures/server-preload-env-reader.mjs'),
  );

  assert.ok(accesses.some((entry) => (
    entry.operation === 'read' &&
    entry.key === 'OPENCHAMBER_PRELOAD_ENV_GUARD_FIXTURE' &&
    entry.frame.includes('server-preload-env-reader.mjs')
  )));
});

test('keeps the guard active through an explicit environment readiness signal', async () => {
  const processLike = { env: { LATE: '1' } };
  let triggerRead;
  const readTrigger = new Promise((resolve) => { triggerRead = resolve; });
  let finishRead;
  const readFinished = new Promise((resolve) => { finishRead = resolve; });
  let markEnvironmentReady;
  const environmentReady = new Promise((resolve) => { markEnvironmentReady = resolve; });
  let markSettling;
  const settling = new Promise((resolve) => { markSettling = resolve; });

  const capture = capturePreloadEnvironmentAccesses(() => {
    void readTrigger.then(() => {
      void processLike.env.LATE;
      finishRead();
    });
  }, {
    processLike,
    settle: () => {
      markSettling();
      return environmentReady;
    },
  });

  await settling;
  triggerRead();
  await readFinished;
  markEnvironmentReady();
  const { accesses } = await capture;

  assert.ok(accesses.some((entry) => (
    entry.operation === 'read' &&
    entry.key === 'LATE' &&
    entry.frame.includes('server-preload-env.test.mjs')
  )));
});

test('the production server dependency preload graph does not access process.env', async () => {
  const originalEnv = process.env;
  const { value, accesses } = await capturePreloadEnvironmentAccesses(
    () => import('@openchamber/web/server/preload-server-dependencies.js'),
  );

  assert.strictEqual(process.env, originalEnv);
  assert.equal(value.serverDependenciesPreloaded, true);
  assert.deepEqual(accesses, [], `Unexpected preload environment accesses:\n${JSON.stringify(accesses, null, 2)}`);
});
