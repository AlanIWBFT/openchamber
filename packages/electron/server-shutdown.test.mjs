import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopEmbeddedServer } from './server-shutdown.mjs';

test('waits for backend-owned children before allowing Electron to exit', async () => {
  let release;
  let stopped = false;
  let options;
  const cleanup = new Promise((resolve) => { release = resolve; });
  const deadline = Date.now() + 5000;
  const stopping = stopEmbeddedServer({ stop(input) { options = input; return cleanup; } }, {
    deadline,
    warn() { assert.fail('normal shutdown must succeed'); },
  }).then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(options, { exitProcess: false, deadline });
  release();
  await stopping;
  assert.equal(stopped, true);
});

test('reports backend cleanup errors without taking over process ownership', async () => {
  const warnings = [];
  await stopEmbeddedServer({
    stop: () => Promise.reject(new Error('fixture')),
    getOpenCodeProcessInfo() { assert.fail('termination stays with the backend owner'); },
  }, { deadline: Date.now() + 5000, warn: (error) => warnings.push(error) });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'fixture');
});

test('remote-only Desktop has no local backend to stop', async () => {
  await stopEmbeddedServer(null, {
    warn() { assert.fail('missing local backend is normal'); },
  });
});
