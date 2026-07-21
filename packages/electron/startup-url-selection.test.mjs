import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStartupUrlProbePlan, shouldIgnoreLoopbackConnectionLimit } from './startup-url-selection.mjs';

test('bundled development never probes HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: true,
    skipLocalServer: false,
  }), {
    probeHmrUi: false,
  });
});

test('HMR development probes only the external UI endpoint', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrUi: true,
  });
});

test('serverless HMR development still probes the UI endpoint', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: true,
    packagedUi: false,
    skipLocalServer: true,
  }), {
    probeHmrUi: true,
  });
});

test('production does not probe HMR endpoints', () => {
  assert.deepEqual(resolveStartupUrlProbePlan({
    development: false,
    packagedUi: false,
    skipLocalServer: false,
  }), {
    probeHmrUi: false,
  });
});

test('keeps Chromium connection limits for the Vite HMR module graph', () => {
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: false }), false);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: true, packagedUi: true }), true);
  assert.equal(shouldIgnoreLoopbackConnectionLimit({ development: false, packagedUi: false }), true);
});
