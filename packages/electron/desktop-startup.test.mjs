import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesktopDeepLinkQueue, createDesktopStartup } from './desktop-startup.mjs';

test('renderer configuration does not wait for OpenCode or complete a migration', async () => {
  const published = [];
  const startup = createDesktopStartup((snapshot) => published.push(snapshot));
  startup.update('migrating');
  startup.configure();
  await startup.waitForConfiguration();
  assert.equal(startup.getState().phase, 'migrating');
  startup.update('finalizing');
  startup.update('ready');
  startup.update('migrating');
  assert.deepEqual(published.map((snapshot) => snapshot.phase), ['migrating', 'finalizing', 'ready']);
  assert.deepEqual(startup.getState(), { phase: 'ready', revision: 3 });
});

test('OpenCode failure does not release incomplete runtime configuration for a remote window', async () => {
  const startup = createDesktopStartup(() => {});
  let configured = false;
  const configuration = startup.waitForConfiguration().then(() => { configured = true; });
  startup.update('failed');
  await Promise.resolve();
  assert.equal(configured, false);
  startup.configure();
  await configuration;
  startup.update('ready');
  assert.equal(startup.getState().phase, 'failed');
});

test('configuration can fail after OpenCode is already ready', async () => {
  const startup = createDesktopStartup(() => {});
  startup.update('ready');
  startup.update('failed');
  startup.configure();
  await startup.waitForConfiguration();
  assert.equal(startup.getState().phase, 'failed');
});

test('runtime configuration and OpenCode readiness do not count as document load success', () => {
  const startup = createDesktopStartup(() => {});
  startup.configure();
  startup.update('ready');
  assert.equal(startup.documentFailed(), true);
  startup.documentLoaded();
  assert.equal(startup.documentFailed(), false);
});

test('a successful first document leaves subsequent navigation failures to normal runtime handling', () => {
  const startup = createDesktopStartup(() => {});
  startup.documentLoaded();
  assert.equal(startup.documentFailed(), false);
});

test('deep links wait for the navigation receiver and repeated readiness does not replay them', async () => {
  let ready = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: () => ready,
    dispatch: (link) => delivered.push(link),
    onError: assert.fail,
  });
  const session = { type: 'session', value: 'session-one', directory: '/project' };
  queue.enqueue(session);
  queue.enqueue({ type: 'focus', value: '' });
  await queue.flush();
  assert.deepEqual(delivered, []);
  ready = true;
  await queue.flush();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0], session);
  await queue.flush();
  assert.equal(delivered.length, 2);
});

test('host navigation retains following sessions until the new receiver is ready', async () => {
  let ready = false;
  const delivered = [];
  let finishNavigation;
  const navigation = new Promise((resolve) => { finishNavigation = resolve; });
  const queue = createDesktopDeepLinkQueue({
    isReady: () => ready,
    dispatch: async (link) => {
      delivered.push(link.type);
      if (link.type === 'host') {
        ready = false;
        await navigation;
      }
    },
    onError: assert.fail,
  });
  queue.enqueue({ type: 'host', value: 'host-one' });
  queue.enqueue({ type: 'session', value: 'session-one' });
  ready = true;
  const flushing = queue.flush();
  await queue.flush();
  assert.deepEqual(delivered, ['host']);
  finishNavigation();
  await flushing;
  assert.deepEqual(delivered, ['host']);
  ready = true;
  await queue.flush();
  assert.deepEqual(delivered, ['host', 'session']);
});

test('native connection links can run at the login screen without a session receiver', async () => {
  let configured = false;
  let receiverReady = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: (link) => configured && (link.type !== 'session' || receiverReady),
    dispatch: (link) => delivered.push(link.type),
    onError: assert.fail,
  });
  queue.enqueue({ type: 'connect' });
  queue.enqueue({ type: 'session' });
  configured = true;
  await queue.flush();
  assert.deepEqual(delivered, ['connect']);
  receiverReady = true;
  await queue.flush();
  assert.deepEqual(delivered, ['connect', 'session']);
});

test('focus bypasses blocked sessions without dropping or reordering them', async () => {
  let receiverReady = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: (link) => link.type !== 'session' || receiverReady,
    dispatch: (link) => delivered.push(link.value),
    onError: assert.fail,
  });
  queue.enqueue({ type: 'session', value: 'one' });
  queue.enqueue({ type: 'session', value: 'two' });
  queue.enqueue({ type: 'focus', value: 'focus' });
  await queue.flush();
  assert.deepEqual(delivered, ['focus']);
  receiverReady = true;
  await queue.flush();
  await queue.flush();
  assert.deepEqual(delivered, ['focus', 'one', 'two']);
});

for (const type of ['connect', 'host']) {
  test(`${type} bypasses blocked sessions and cancels only those preceding its navigation`, async () => {
    let configured = false;
    let receiverReady = false;
    let beginSwitch;
    const confirmation = new Promise((resolve) => { beginSwitch = resolve; });
    let finishNavigation;
    const navigation = new Promise((resolve) => { finishNavigation = resolve; });
    const delivered = [];
    const queue = createDesktopDeepLinkQueue({
      isReady: (link) => configured && (link.type !== 'session' || receiverReady),
      dispatch: async (link, onHostSwitch) => {
        delivered.push(link.value);
        if (link.type === type) {
          await confirmation;
          onHostSwitch();
          receiverReady = false;
          await navigation;
        }
      },
      onError: assert.fail,
    });
    queue.enqueue({ type: 'session', value: 'old-one' });
    queue.enqueue({ type: 'session', value: 'old-two' });
    queue.enqueue({ type, value: 'switch' });
    queue.enqueue({ type: 'session', value: 'following' });
    assert.deepEqual(delivered, []);
    configured = true;
    const flushing = queue.flush();
    assert.deepEqual(delivered, ['switch']);
    queue.enqueue({ type: 'session', value: 'arrived-during-confirmation' });
    receiverReady = true;
    await queue.flush();
    assert.deepEqual(delivered, ['switch']);
    beginSwitch();
    finishNavigation();
    await flushing;
    assert.deepEqual(delivered, ['switch']);
    receiverReady = true;
    await queue.flush();
    await queue.flush();
    assert.deepEqual(delivered, ['switch', 'following', 'arrived-during-confirmation']);
  });
}

for (const outcome of ['declined-connect', 'unknown-host', 'failed-before-navigation', 'failed-after-navigation-start']) {
  test(`${outcome} preserves the correct pending session scope`, async () => {
    let configured = false;
    let receiverReady = false;
    const delivered = [];
    const errors = [];
    const queue = createDesktopDeepLinkQueue({
      isReady: (link) => configured && (link.type !== 'session' || receiverReady),
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
    receiverReady = true;
    await queue.flush();
    assert.deepEqual(delivered, outcome === 'failed-after-navigation-start' ? ['switch', 'following'] : ['switch', 'old', 'following']);
  });
}

test('links cannot overtake a native operation that is not ready', async () => {
  let nativeReady = false;
  const delivered = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: (link) => link.type === 'session' || nativeReady,
    dispatch: (link) => delivered.push(link.type),
    onError: assert.fail,
  });
  queue.enqueue({ type: 'host' });
  queue.enqueue({ type: 'session' });
  await queue.flush();
  assert.deepEqual(delivered, []);
  nativeReady = true;
  await queue.flush();
  assert.deepEqual(delivered, ['host', 'session']);
});

test('failed dispatch is reported once without retrying the link or losing the remaining queue', async () => {
  let ready = false;
  const attempted = [];
  const errors = [];
  const queue = createDesktopDeepLinkQueue({
    isReady: () => ready,
    dispatch: (link) => {
      attempted.push(link);
      if (link === 'bad') throw new Error('dispatch failed');
    },
    onError: (error) => errors.push(error.message),
  });
  queue.enqueue('bad');
  queue.enqueue('good');
  ready = true;
  await queue.flush();
  await queue.flush();
  assert.deepEqual(attempted, ['bad', 'good']);
  assert.deepEqual(errors, ['dispatch failed']);
});

test('main wiring uses receiver readiness rather than a fixed post-load delay', () => {
  const main = readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../ui/src/App.tsx', import.meta.url), 'utf8');
  assert.ok(!main.includes('setTimeout(flushPendingDeepLinks, 400)'));
  assert.ok(main.includes('state.mainWindow.__ocNavigationFrame === state.mainWindow.webContents.mainFrame'));
  assert.ok(main.includes('details.isMainFrame && !details.isSameDocument'));
  assert.ok(main.includes("link.type !== 'session' || state.mainWindow.__ocNavigationFrame"));
  assert.match(main, /desktopStartup\.configure\(\);\s+void pendingDeepLinks\.flush\(\);/);
  assert.ok(main.includes('event.senderFrame !== event.sender.mainFrame || (args?.ready !== true && args?.ready !== false)'));
  assert.ok(main.includes('reportInitialDocumentFailure({ errno: errorCode, message: errorDescription });'));
  assert.ok(main.includes('dispatch: (link, onHostSwitch) => dispatchDeepLink(link, onHostSwitch)'));
  assert.ok(main.includes('if (id) await switchToHostById(id, onHostSwitch);'));
  assert.ok(main.includes('return switchToHostById(link.value, onHostSwitch);'));
  assert.match(main, /onHostSwitch\(\);\s+await activateMainWindow\(targetUrl,/);
  const listener = app.indexOf("window.addEventListener('openchamber:open-session', handler);");
  assert.ok(listener >= 0 && app.indexOf('reportReady(true);', listener) > listener);
  assert.ok(app.indexOf('reportReady(false);', listener) > listener);
});
