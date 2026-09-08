import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopDeepLinkQueue } from './desktop-deep-links.mjs';

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
