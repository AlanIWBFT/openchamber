import assert from 'node:assert/strict';
import test from 'node:test';

import { createStartupSingleFlight } from './startup-single-flight.mjs';

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
