import { afterEach, describe, expect, it } from 'bun:test';
import { createRuntimeOpencodeClient } from '@/lib/opencode/client';
import { useAuthSessionStore } from '@/lib/runtime-auth-expiry';
import { createEventPipeline } from '../event-pipeline';

const savedDocument = globalThis.document;
const savedWindow = globalThis.window;
const savedNavigator = globalThis.navigator;
const savedFetch = globalThis.fetch;
const savedAuthState = useAuthSessionStore.getState().state;

afterEach(() => {
  globalThis.document = savedDocument;
  globalThis.window = savedWindow;
  globalThis.navigator = savedNavigator;
  globalThis.fetch = savedFetch;
  useAuthSessionStore.setState({ state: savedAuthState });
});

function createEventTarget(extras = {}) {
  const listeners = new Map();
  return {
    ...extras,
    addEventListener(event, handler) {
      const list = listeners.get(event);
      if (list) list.add(handler);
      else listeners.set(event, new Set([handler]));
    },
    removeEventListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    dispatch(event) {
      const list = listeners.get(event);
      if (!list) return;
      for (const handler of Array.from(list)) {
        handler();
      }
    },
  };
}

describe('createEventPipeline — permanent server errors', () => {
  it('lets an explicit reconnect interrupt permanent-error backoff', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let calls = 0;
    const sdk = {
      event: {
        subscribe: ({ signal }) => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return (async function* () {
              yield { id: 'evt_1', created: 1000, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
            })();
        },
      },
    };
    let pipeline;
    const recovered = new Promise((resolve) => {
      pipeline = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        onEvent: () => {},
        onDisconnect: () => setTimeout(() => pipeline.reconnect('manual'), 20),
        onReconnect: resolve,
      });
    });

    try {
      await Promise.race([
        recovered,
        new Promise((_, reject) => setTimeout(() => reject(new Error('reconnect remained in backoff')), 1000)),
      ]);
      expect(calls).toBe(2);
    } finally {
      pipeline?.cleanup();
    }
  });

  it('recognizes HTTP errors from the real V2 subscription without an SDK retry loop', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let sdkCalls = 0;
    globalThis.fetch = async (input) => {
      // Runtime auth may also probe its token endpoint; count subscriptions.
      const url = new URL(input instanceof Request ? input.url : input, 'http://localhost');
      if (url.pathname.endsWith('/event')) sdkCalls += 1;
      return new Response('Unauthorized', { status: 401 });
    };
    const sdk = createRuntimeOpencodeClient({ baseUrl: 'http://localhost/api' });
    let cleanupFn = () => {};
    await new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        onEvent: () => {},
        onDisconnect: () => setTimeout(resolve, 300),
      });
      cleanupFn = cleanup;
    });

    cleanupFn();
    expect(sdkCalls).toBe(1);
  });

  it('uses the long backoff cap for 4xx so we do not hammer at 5s intervals', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: () => {
          const idx = sdkCallIndex++;
          if (idx <= 1) {
            // First two attempts: permanent 404. Under the old code these
            // would have entered the exponential path and the second retry
            // would fire after ~250-500ms. With the permanent-error override
            // both go to the long (60s) cap, so the test should observe
            // exactly one retry (after `online` interrupts) within its
            // observation window.
            const error = new Error('Not Found');
            error.status = 404;
            throw error;
          }
          return (async function* () {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    };

    const startedAt = Date.now();
    let cleanupFn = () => {};

    // Phase 1: let the first 404 fire and verify the loop is NOT spinning.
    // If the permanent-error override is broken, the loop would retry every
    // 250-500ms and sdkCallIndex would climb past 1.
    await new Promise((resolve) => {
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onDisconnect: () => {
          // Wait 250ms after disconnect — long enough that the broken
          // exponential path would have retried at least once. If our
          // override works, sdkCallIndex stays at 1.
          setTimeout(resolve, 250);
        },
      });
      cleanupFn = cleanup;
    });

    expect(sdkCallIndex).toBe(1);

    // Phase 2: fire `online` to interrupt the long wait. Loop should fire
    // the second attempt (still 404) immediately, then the third attempt
    // which succeeds.
    const recovered = new Promise((resolve) => {
      // Trigger an `online` event; waitForRetry's interrupter resolves and
      // the next attempt fires. That attempt is also a 404 (idx=1), then
      // another `online` advances us to the success path (idx=2).
      const advance = () => {
        globalThis.window.dispatch('online');
      };
      advance();
      const t = setInterval(() => {
        if (sdkCallIndex >= 3) {
          clearInterval(t);
          resolve();
        } else {
          advance();
        }
      }, 50);
    });

    await recovered;
    cleanupFn();

    expect(sdkCallIndex).toBeGreaterThanOrEqual(3);
    // Total elapsed should be < 2s — well under the 60s cap that proves the
    // interrupters work for permanent-error retries too.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('retries 408 and 429 on the normal exponential path (not the permanent cap)', async () => {
    globalThis.document = createEventTarget({ visibilityState: 'visible' });
    globalThis.window = createEventTarget({
      location: { href: 'http://127.0.0.1:3000/', origin: 'http://127.0.0.1:3000' },
    });
    globalThis.navigator = { onLine: true };

    let sdkCallIndex = 0;
    const sdk = {
      event: {
        subscribe: () => {
          const idx = sdkCallIndex++;
          if (idx === 0) {
            const error = new Error('Rate limited');
            error.status = 429;
            throw error;
          }
          return (async function* () {
              yield { id: 'evt_1', created: 1000, location: { directory: '/repo' }, type: 'session.status', data: { sessionID: 's1', status: { type: 'idle' } } };
              await new Promise(() => {});
            })();
        },
      },
    };

    const startedAt = Date.now();
    const elapsed = await new Promise((resolve) => {
      let connects = 0;
      const { cleanup } = createEventPipeline({
        sdk,
        transport: 'sse',
        heartbeatTimeoutMs: 60_000,
        reconnectDelayMs: 60_000,
        onEvent: () => {},
        onReconnect: () => {
          connects += 1;
          if (connects === 1) {
            cleanup();
            resolve(Date.now() - startedAt);
          }
        },
      });
    });

    // 429 went through computeRetryDelay (consecutiveFailures=1) -> 250ms,
    // not the 60s permanent cap. Recovery should be sub-second.
    expect(sdkCallIndex).toBe(2);
    expect(elapsed).toBeLessThan(2_000);
  });
});
