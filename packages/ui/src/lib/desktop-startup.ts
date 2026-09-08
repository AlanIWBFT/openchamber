import { z } from 'zod';
import { useEffect } from 'react';
import { initializeLocale, useI18nStore } from './i18n';
import { getBootInjectionStatus } from './desktopBoot';

const startupStateSchema = z.object({
  phase: z.enum(['launching', 'migrating', 'finalizing', 'ready', 'failed']),
  revision: z.number().int().nonnegative(),
});
const runtimeUrlSchema = z.union([z.literal(''), z.url()]);
const bootstrapSchema = z.object({ localOrigin: runtimeUrlSchema, localProxyOrigin: runtimeUrlSchema, state: startupStateSchema });
type StartupState = z.infer<typeof startupStateSchema>;
type DesktopStartupBootstrap = z.infer<typeof bootstrapSchema>;

declare global {
  interface Window {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_STARTUP__?: {
      bootstrap: () => Promise<DesktopStartupBootstrap>;
      subscribe: (listener: (snapshot: StartupState) => void) => () => void;
    };
  }
}

export function createDesktopStartupReadiness() {
  let state: StartupState = { phase: 'launching', revision: 0 };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    update(input: StartupState) {
      const next = startupStateSchema.parse(input);
      if (state.phase === 'failed' || next.revision < state.revision) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    wait(signal?: AbortSignal, runtimeEvents?: EventTarget): Promise<void> {
      return new Promise((resolve, reject) => {
        const finish = (error?: Error) => {
          listeners.delete(check);
          signal?.removeEventListener('abort', abort);
          runtimeEvents?.removeEventListener('openchamber:runtime-endpoint-will-change', switched);
          if (error) reject(error);
          else resolve();
        };
        const abort = () => finish(new DOMException('Request cancelled', 'AbortError'));
        const switched = () => finish(new DOMException('Runtime changed during startup', 'AbortError'));
        const check = () => {
          if (signal?.aborted) return abort();
          if (state.phase === 'failed') return finish(new Error('OpenChamber startup failed. Restart OpenChamber.'));
          if (state.phase === 'ready') finish();
        };
        listeners.add(check);
        signal?.addEventListener('abort', abort, { once: true });
        runtimeEvents?.addEventListener('openchamber:runtime-endpoint-will-change', switched, { once: true });
        check();
      });
    },
  };
}

const readiness = createDesktopStartupReadiness();
let localOrigin = '';
let localProxyOrigin = '';
let rendered = false;
let bootstrapFailed = false;
let updateLoading: (() => void) | undefined;

export const isDesktopStartupManaged = () => updateLoading !== undefined;

export function failDesktopStartup(): void {
  if (!updateLoading) return;
  bootstrapFailed = true;
  readiness.update({ phase: 'failed', revision: readiness.getState().revision + 1 });
  updateLoading();
}

// App rendering is independent of OpenCode readiness. Migration alone restores
// the blocking loading surface after the ordinary shell has become visible.
export function DesktopStartupReady(): null {
  useEffect(() => {
    rendered = true;
    updateLoading?.();
  }, []);
  return null;
}

export function isDesktopStartupLocalTarget(baseUrl: string, localOrigin: string, localProxyOrigin: string, pageUrl: string): boolean {
  if (!localOrigin) return false;
  const origin = new URL(baseUrl || '.', pageUrl).origin;
  return origin === localOrigin || (Boolean(localProxyOrigin) && origin === localProxyOrigin);
}

export async function waitForDesktopOpenCode(baseUrl: string, signal?: AbortSignal): Promise<void> {
  if (!localOrigin || !isDesktopStartupLocalTarget(baseUrl, localOrigin, localProxyOrigin, window.location.href)) return;
  await readiness.wait(signal, window);
}

export async function initializeDesktopStartup(): Promise<void> {
  const bridge = window.__OPENCHAMBER_STARTUP__;
  if (!bridge) return;
  const loading = document.getElementById('initial-loading');
  const root = document.getElementById('root');
  if (!loading || !root) throw new Error('Desktop startup loading element is missing');
  loading.dataset.desktopStartup = 'true';
  document.body.appendChild(loading);
  const title = document.createElement('h1');
  const detail = document.createElement('p');
  loading.append(title, detail);
  loading.setAttribute('role', 'status');
  loading.setAttribute('aria-live', 'polite');
  initializeLocale();
  let bootstrapComplete = false;
  let activeApiBaseUrl = '';
  updateLoading = () => {
    const { phase } = readiness.getState();
    const local = isDesktopStartupLocalTarget(activeApiBaseUrl, localOrigin, localProxyOrigin, window.location.href);
    const failed = bootstrapFailed || (local && phase === 'failed');
    const migrating = local && (phase === 'migrating' || phase === 'finalizing');
    const visible = failed || migrating || !bootstrapComplete || !rendered;
    const { dictionary } = useI18nStore.getState();
    title.hidden = !failed && !migrating;
    detail.hidden = !failed && !migrating;
    title.textContent = dictionary[failed ? 'startup.failed' : migrating ? phase === 'migrating' ? 'startup.migrating' : 'startup.finalizing' : 'startup.launching'];
    detail.textContent = failed ? dictionary['startup.restartDetail'] : migrating ? dictionary['startup.migrationDetail'] : '';
    loading.style.display = visible ? 'flex' : 'none';
    root.inert = visible;
  };
  const unsubscribeState = readiness.subscribe(updateLoading);
  const unsubscribeLocale = useI18nStore.subscribe(updateLoading);
  const unsubscribeBridge = bridge.subscribe((snapshot) => {
    try { readiness.update(snapshot); } catch { failDesktopStartup(); }
  });
  const onRuntimeChanged = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const parsed = z.object({ apiBaseUrl: runtimeUrlSchema }).safeParse(event.detail);
    if (!parsed.success) return;
    activeApiBaseUrl = parsed.data.apiBaseUrl;
    updateLoading?.();
  };
  window.addEventListener('openchamber:runtime-endpoint-changed', onRuntimeChanged);
  window.addEventListener('pagehide', () => {
    unsubscribeBridge();
    unsubscribeState();
    unsubscribeLocale();
    window.removeEventListener('openchamber:runtime-endpoint-changed', onRuntimeChanged);
  }, { once: true });
  updateLoading();
  try {
    const bootstrap = bootstrapSchema.parse(await bridge.bootstrap());
    if (getBootInjectionStatus() !== 'valid') throw new Error('Desktop runtime configuration is missing or invalid');
    localOrigin = bootstrap.localOrigin ? new URL(bootstrap.localOrigin).origin : '';
    localProxyOrigin = bootstrap.localProxyOrigin ? new URL(bootstrap.localProxyOrigin).origin : '';
    const configuredApiBaseUrl = runtimeUrlSchema.parse(window.__OPENCHAMBER_API_BASE_URL__ || '');
    activeApiBaseUrl = configuredApiBaseUrl;
    readiness.update(bootstrap.state);
    bootstrapComplete = true;
    updateLoading();
    if (!configuredApiBaseUrl && bootstrap.state.phase === 'failed') throw new Error('Desktop bootstrap failed');
  } catch (error) {
    failDesktopStartup();
    throw error;
  }
}
