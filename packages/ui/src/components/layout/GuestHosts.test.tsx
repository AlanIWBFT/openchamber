import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import { hostMessageSchema } from '@openchamber/sdk/schemas';
import type { GuestMessage, HostMessage } from '@openchamber/sdk';
import { toast } from 'sonner';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';
import { I18nProvider } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { runGuestAction, useGuestActionHostStore } from '@/lib/guests/run-action';
import type { GuestActionEntry } from '@/lib/guests/actions';
import { useGuestsStore } from '@/lib/guests/store';
import { useGuestDialogStore } from '@/lib/guests/dialog-store';
import { useGuestItemStore } from '@/lib/guests/item-store';
import { useGuestBadgeStore } from '@/lib/guests/badge-store';
import { SyncProvider } from '@/sync/sync-context';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { GuestHosts } from './GuestHosts';

test('background host handles hello/load once, pins context, ignores foreign replies and unmounts after completion', async () => {
  const dom = new Window({ url: 'http://guest.test', settings: { disableIframePageLoading: true } });
  const guestWindow = new Window();
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator,
    localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom), Event: dom.Event, MessageEvent: dom.MessageEvent,
    IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input).includes('/auth/url-token')) return Response.json({ token: 'scoped-test', expiresAt: Date.now() + 60_000 });
    return Response.json({});
  });
  const notice = spyOn(toast, 'info').mockImplementation(() => 'toast');
  const error = spyOn(toast, 'error').mockImplementation(() => 'error');
  const clipboard = spyOn(dom.navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  const dismiss = spyOn(toast, 'dismiss').mockImplementation(() => 'dismissed');
  const sdk = createOpencodeClient({ baseUrl: 'http://sync.test', fetch: async (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (url.pathname.endsWith('/global/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    return Response.json(url.pathname.endsWith('/session/status') ? {} : []);
  } });
  const theme = getDefaultTheme(false);
  const themeContext: ThemeContextValue = {
    currentTheme: theme, availableThemes: [theme], customThemeIds: [], setTheme: () => {}, customThemesLoading: false,
    reloadCustomThemes: async () => {}, importTheme: async () => theme, deleteImportedTheme: async () => {},
    isSystemPreference: false, setSystemPreference: () => {}, themeMode: 'light', setThemeMode: () => {},
    lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id, setLightThemePreference: () => {}, setDarkThemePreference: () => {},
  };
  const action: GuestActionEntry['action'] = { id: 'count', label: 'Count', where: 'message', mode: 'background' };
  const entry: GuestActionEntry = { action, icon: 'window', guest: {
    id: 'counter', name: 'Counter', icon: 'window', entry: 'panel/index.html', attach: 'dialog', attachEntry: 'panel/dialog.html',
    capabilities: { requested: [], granted: [] }, actions: [action],
  } };
  const runtimeKey = getRuntimeKey();
  useGuestsStore.getState().resetForRuntimeSwitch(runtimeKey);
  useGuestsStore.getState().replaceCatalog([entry.guest], runtimeKey);
  useGuestBadgeStore.getState().setBadge('counter', 5);
  const parkedItem = { providerId: 'counter', id: 'parked', title: 'Keep', url: 'https://example.com' };
  useGuestItemStore.getState().setPendingItem('counter', parkedItem);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let done = Promise.resolve();
  const messages: HostMessage[] = [];
  let restorePost = () => {};
  try {
    await act(async () => root.render(<React.StrictMode><I18nProvider><ThemeSystemContext.Provider value={themeContext}>
      <SyncProvider sdk={sdk} directory="/visible"><GuestHosts /></SyncProvider>
    </ThemeSystemContext.Provider></I18nProvider></React.StrictMode>));
    await act(async () => {
      done = runGuestAction(entry, { kind: 'message', action: 'count', sessionId: 'target', sessionTitle: 'Target', directory: '/target', messageId: 'm1', role: 'assistant', text: 'Hello' }, (key) => key);
    });
    for (let attempt = 0; attempt < 100 && !container.querySelector('iframe'); attempt++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    const frame = container.querySelector('iframe');
    if (!frame) throw new Error('Background iframe did not mount');
    // Frame navigation is disabled in this DOM. Supply a separate guest
    // window to exercise the real host's source checks and postMessage path.
    Object.defineProperty(frame, 'contentWindow', { configurable: true, value: guestWindow });
    if (!frame.contentWindow) throw new Error('Guest window is missing');
    const frameWindow = frame.contentWindow;
    const post = spyOn(frameWindow, 'postMessage').mockImplementation((data) => { messages.push(hostMessageSchema.parse(data)); });
    restorePost = () => post.mockRestore();
    const send = (message: GuestMessage, source = frameWindow) => window.dispatchEvent(new MessageEvent('message', { source, data: message }));
    expect(frame.src.includes('/panel/index.html')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.closest('[aria-hidden="true"]')).not.toBeNull();
    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
      frame.dispatchEvent(new Event('load'));
      send({ channel: 'openchamber.sdk', v: 1, type: 'hello' });
    });
    const actionMessage = messages.find((message) => message.type === 'action');
    if (!actionMessage || actionMessage.type !== 'action') throw new Error('No action dispatched');
    expect(messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(messages.find((message) => message.type === 'ready')).toMatchObject({ payload: { surface: 'background', item: null, directory: '/target', session: { id: 'target' } } });
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'another-chat' }); });
    expect(messages.filter((message) => message.type === 'action')).toHaveLength(1);
    expect(useGuestDialogStore.getState().request).toBeNull();
    expect(useGuestItemStore.getState().pendingItemByGuest.counter).toEqual(parkedItem);
    expect(useGuestBadgeStore.getState().countByGuest.counter).toBe(5);
    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'action-result', id: 'wrong-id', payload: { ok: true } });
      send({ channel: 'openchamber.sdk', v: 1, type: 'action-result', id: actionMessage.id, payload: { ok: true } }, window);
      send({ channel: 'openchamber.sdk', v: 1, type: 'toast', id: 'toast-1', payload: { kind: 'info', message: 'Counted', copy: true, persistent: true } });
    });
    expect(useGuestActionHostStore.getState().requests.length).toBe(1);
    expect(notice.mock.calls.length).toBe(1);
    expect(messages.some((message) => message.type === 'result' && message.id === 'toast-1' && message.ok)).toBe(true);
    await act(async () => {
      send({ channel: 'openchamber.sdk', v: 1, type: 'action-result', id: actionMessage.id, payload: { ok: true } });
      send({ channel: 'openchamber.sdk', v: 1, type: 'toast', id: 'late', payload: { kind: 'info', message: 'Too late' } });
      await done;
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(notice.mock.calls.length).toBe(1);
    expect(error.mock.calls.length).toBe(0);
    await act(async () => {
      done = runGuestAction(entry, { kind: 'message', action: 'count', sessionId: 'target', sessionTitle: 'Target', directory: '/target', messageId: 'm2', role: 'assistant', text: 'Next' }, (key) => key);
    });
    expect(useGuestActionHostStore.getState().requests.length).toBe(1);
    await act(async () => { root.render(null); });
    await done;
    expect(useGuestActionHostStore.getState().requests.length).toBe(0);
    const toastOptions = notice.mock.calls[0]?.[1];
    const buttons = toastOptions?.action;
    if (!React.isValidElement(buttons)) throw new Error('Toast buttons missing after frame teardown');
    expect(toastOptions?.duration).toBe(Infinity);
    await act(async () => root.render(<I18nProvider>{buttons}</I18nProvider>));
    const copyButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Copy');
    if (!copyButton) throw new Error('Missing Copy');
    await act(async () => copyButton.click());
    expect(clipboard.mock.calls[0]?.[0]).toBe('Counted');
    expect(dismiss.mock.calls.length).toBe(0);
    const okButton = [...container.querySelectorAll('button')].find((button) => button.textContent === 'OK');
    if (!okButton) throw new Error('Missing OK');
    await act(async () => okButton.click());
    expect(dismiss.mock.calls[0]?.[0]).toBe(toastOptions?.id);
  } finally {
    await act(async () => root.unmount());
    await done;
    restorePost(); fetch.mockRestore(); notice.mockRestore(); error.mockRestore();
    clipboard.mockRestore(); dismiss.mockRestore();
    useSessionUIStore.setState({ currentSessionId: null });
    await dom.happyDOM.close();
    await guestWindow.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
