import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopDeepLinkQueue, createDesktopNavigationReadiness } from './desktop-deep-links.mjs';

test('only remote documents get a fallback, retired on navigation, receiver readiness and shutdown', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let deliveries = 0;
  const readiness = createDesktopNavigationReadiness({ onReady: () => deliveries++ });
  const local = {};
  const remote = {};
  readiness.loaded(local, false);
  t.mock.timers.tick(20_000);
  assert.equal(readiness.isReady(local), false);
  assert.equal(deliveries, 0);
  readiness.report(local, true);
  assert.equal(readiness.isReady(local), true);
  readiness.reset();
  readiness.loaded(remote, true);
  t.mock.timers.tick(9_999);
  assert.equal(readiness.isReady(remote), false);
  t.mock.timers.tick(1);
  assert.equal(readiness.isReady(remote), true);
  assert.equal(readiness.isReady(local), false);
  assert.equal(deliveries, 2);
  readiness.reset();
  readiness.loaded(remote, true);
  readiness.report(remote, true);
  t.mock.timers.tick(10_000);
  assert.equal(deliveries, 3);
  readiness.reset();
  readiness.loaded(remote, true);
  readiness.reset();
  readiness.loaded(local, false);
  t.mock.timers.tick(10_000);
  assert.equal(readiness.isReady(local), false);
  assert.equal(deliveries, 3);
  readiness.loaded(remote, true);
  readiness.report(remote, false);
  t.mock.timers.tick(10_000);
  assert.equal(readiness.isReady(remote), false);
  assert.equal(deliveries, 3);
});

test('receiver readiness releases sessions once and keeps their directory', async () => {
  let ready = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({ isReady: () => ready, dispatch: (link) => delivered.push(link), onError: assert.fail });
  const session = { type: 'session', value: 'one', directory: '/project' };
  queue.enqueue(session);
  await queue.flush();
  assert.deepEqual(delivered, []);
  ready = true;
  await queue.flush();
  await queue.flush();
  assert.deepEqual(delivered, [session]);
});

test('native focus bypasses blocked sessions without dropping or reordering them', async () => {
  let ready = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: (link) => link.type !== 'session' || ready,
    dispatch: (link) => delivered.push(link.value),
    onError: assert.fail,
  });
  queue.enqueue({ type: 'session', value: 'one' });
  queue.enqueue({ type: 'session', value: 'two' });
  queue.enqueue({ type: 'focus', value: 'focus' });
  await queue.flush();
  assert.deepEqual(delivered, ['focus']);
  ready = true;
  await queue.flush();
  assert.deepEqual(delivered, ['focus', 'one', 'two']);
});

for (const type of ['connect', 'host']) {
  test(`${type} cancels preceding sessions only when confirmed navigation begins`, async () => {
    let configured = false;
    let ready = false;
    let confirm;
    const confirmation = new Promise((resolve) => { confirm = resolve; });
    let finish;
    const navigation = new Promise((resolve) => { finish = resolve; });
    const delivered = [];
    const queue = createDesktopDeepLinkQueue({
      isReady: (link) => configured && (link.type !== 'session' || ready),
      dispatch: async (link, onHostSwitch) => {
        delivered.push(link.value);
        if (link.type === type) {
          await confirmation;
          onHostSwitch();
          ready = false;
          await navigation;
        }
      },
      onError: assert.fail,
    });
    queue.enqueue({ type: 'session', value: 'old-one' });
    queue.enqueue({ type: 'session', value: 'old-two' });
    queue.enqueue({ type, value: 'switch' });
    queue.enqueue({ type: 'session', value: 'following' });
    configured = true;
    const flushing = queue.flush();
    assert.deepEqual(delivered, ['switch']);
    queue.enqueue({ type: 'session', value: 'during-confirmation' });
    ready = true;
    await queue.flush();
    assert.deepEqual(delivered, ['switch']);
    confirm();
    finish();
    await flushing;
    assert.deepEqual(delivered, ['switch']);
    ready = true;
    await queue.flush();
    await queue.flush();
    assert.deepEqual(delivered, ['switch', 'following', 'during-confirmation']);
  });
}

for (const outcome of ['declined-connect', 'unknown-host', 'failed-before-navigation', 'failed-after-navigation-start']) {
  test(`${outcome} preserves the correct session scope`, async () => {
    let configured = false;
    let ready = false;
    const delivered = [];
    const errors = [];
    const queue = createDesktopDeepLinkQueue({
      isReady: (link) => configured && (link.type !== 'session' || ready),
      dispatch: (link, onHostSwitch) => {
        delivered.push(link.value);
        if (link.type === 'session') return;
        if (outcome === 'failed-after-navigation-start') onHostSwitch();
        if (outcome.startsWith('failed-')) throw new Error(outcome);
      },
      onError: (error) => errors.push(error.message),
    });
    queue.enqueue({ type: 'session', value: 'old' });
    queue.enqueue({ type: outcome === 'unknown-host' ? 'host' : 'connect', value: 'switch' });
    queue.enqueue({ type: 'session', value: 'following' });
    configured = true;
    await queue.flush();
    assert.deepEqual(delivered, ['switch']);
    assert.deepEqual(errors, outcome.startsWith('failed-') ? [outcome] : []);
    ready = true;
    await queue.flush();
    assert.deepEqual(delivered, outcome === 'failed-after-navigation-start' ? ['switch', 'following'] : ['switch', 'old', 'following']);
  });
}

test('a native operation that is not ready cannot be overtaken', async () => {
  let ready = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: (link) => link.type === 'session' || ready,
    dispatch: (link) => delivered.push(link.type),
    onError: assert.fail,
  });
  queue.enqueue({ type: 'host' });
  queue.enqueue({ type: 'session' });
  await queue.flush();
  assert.deepEqual(delivered, []);
  ready = true;
  await queue.flush();
  assert.deepEqual(delivered, ['host', 'session']);
});
