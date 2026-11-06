import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as desktop from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { clearDiagnosticEvents, getDiagnosticEvents } from './timeline';
import { getSessionRoutingIdentity, observeSessionRouting, recordSessionRouting, reportModelCacheMismatch, subscribeModelCacheIncidents } from './session-routing';

const record = { id: 'ses_private', directory: 'G:\\private\\project', model: { providerID: 'private-provider', id: 'private-model' }, time: { updated: 1 } };
let writes: string[];
let sink: ReturnType<typeof spyOn<typeof desktop, 'writeDesktopRoutingDiagnostic'>>;

beforeEach(() => {
  clearDiagnosticEvents();
  writes = [];
  sink = spyOn(desktop, 'writeDesktopRoutingDiagnostic').mockImplementation((text) => { writes.push(text); });
});
afterEach(() => sink.mockRestore());

test('the first foreign insertion keeps its source and owner without private fields', () => {
  observeSessionRouting('H:/private/desktop', [record], [], 'store');
  expect(writes).toHaveLength(1);
  const event = JSON.parse(writes[0]!);
  expect(event.action).toBe('store-add');
  expect(event.source).toBe('store');
  expect(event.directory).not.toBe(event.owner);
  expect(event.session).toBe(getSessionRoutingIdentity(record.id).session);
  expect(event.sites.length).toBeGreaterThan(0);
  for (const privateValue of [record.id, 'private', record.directory]) expect(writes[0]).not.toContain(privateValue);
});

test('Windows slash and case differences do not produce a foreign insertion', () => {
  observeSessionRouting('g:/PRIVATE/project/', [record], [], 'restore');
  expect(writes).toHaveLength(0);
});

test('streaming time and usage updates do not emit per-record diagnostics', () => {
  const previous = Array.from({ length: 2_000 }, (_, index) => ({ ...record, id: `ses_${index.toString().padStart(5, '0')}` }));
  const next = previous.map((session) => ({ ...session, time: { updated: 2 }, cost: 1 }));
  observeSessionRouting('G:/private/project', next, previous, 'store');
  expect(writes).toHaveLength(0);
  expect(getDiagnosticEvents()).toHaveLength(0);
});

test('an incident is deduplicated, keeps its snapshot, and rearms after a consistent read', () => {
  const incident = { sessionId: 'ses_notice', directory: 'G:/private/project' };
  const received: Array<{ reference: string; text: string }> = [];
  const stop = subscribeModelCacheIncidents((value) => received.push(value));
  try {
    reportModelCacheMismatch(incident, true, false);
    reportModelCacheMismatch(incident, true, false);
    expect(received).toHaveLength(1);
    clearDiagnosticEvents();
    expect(received[0]?.text).toContain(received[0]!.reference);
    expect(received[0]?.text).toContain('model-cache-mismatch');
    reportModelCacheMismatch(incident, false, true);
    reportModelCacheMismatch(incident, true, false);
    expect(received).toHaveLength(2);
  } finally { stop(); }
});

test('a failing desktop sink cannot change the observed operation', () => {
  sink.mockImplementation(() => { throw new Error('unavailable'); });
  recordSessionRouting({ action: 'send-route', source: 'send', sessionId: 'ses_sink' });
  expect(getDiagnosticEvents().at(-1)?.action).toBe('send-route');
});

for (const status of [204, 503]) {
  test(`a remote model switch finishing after return to local cannot enter local diagnostics (${status})`, async () => {
    sink.mockRestore();
    const originalWindow = globalThis.window;
    const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
    let requested = () => {};
    const started = new Promise<void>((resolve) => { requested = resolve; });
    let respond = (_response: Response) => {};
    const held = new Promise<Response>((resolve) => { respond = resolve; });
    const transport = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === '/auth/url-token') return new Response(null, { status: 404 });
      requested();
      return held;
    });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), {
      location: { origin: 'http://127.0.0.1:3917', href: 'http://127.0.0.1:3917/' },
      __OPENCHAMBER_LOCAL_ORIGIN__: 'http://127.0.0.1:3917',
      __OPENCHAMBER_ELECTRON__: { runtime: 'electron' },
      __OPENCHAMBER_DESKTOP__: { invoke: async () => undefined },
      __electronLog: { info: (_tag: string, text: string) => writes.push(text) },
    }) });
    try {
      switchRuntimeEndpoint({ apiBaseUrl: 'https://remote-routing.test', runtimeKey: 'remote-routing' });
      opencodeClient.reconnectToRuntimeBaseUrl();
      const completion = opencodeClient.switchSessionModel('ses_routing_runtime', { providerID: 'proof', id: 'sol' }, '/proof')
        .then(() => 'completed', () => 'failed');
      await started;
      expect(writes).toHaveLength(0);
      switchRuntimeEndpoint({ apiBaseUrl: 'http://127.0.0.1:3917', runtimeKey: 'local' });
      clearDiagnosticEvents();
      respond(new Response(null, { status }));
      expect(await completion).toBe(status === 204 ? 'completed' : 'failed');
      expect(writes).toHaveLength(0);
      expect(getDiagnosticEvents()).toHaveLength(0);
      recordSessionRouting({ action: 'send-route', source: 'send', sessionId: 'ses_local' });
      expect(writes).toHaveLength(1);
      expect(getDiagnosticEvents()).toHaveLength(1);
    } finally {
      respond(new Response(null, { status: 503 }));
      switchRuntimeEndpoint(originalRuntime);
      opencodeClient.reconnectToRuntimeBaseUrl();
      transport.mockRestore();
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
}
