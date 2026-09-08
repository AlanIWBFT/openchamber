import { failDesktopStartup, initializeDesktopStartup } from '@openchamber/ui/lib/desktop-startup';
import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';

declare global {
  interface Window {
    __OPENCHAMBER_RUNTIME_APIS__?: RuntimeAPIs;
  }
}

const start = async () => {
  await initializeDesktopStartup();
  const { createConfiguredWebAPIs } = await import('./runtimeConfig');
  const apis = createConfiguredWebAPIs();
  window.__OPENCHAMBER_RUNTIME_APIS__ = apis;
  const { renderElectronMiniChatApp } = await import('@openchamber/ui/apps/renderElectronMiniChatApp');
  renderElectronMiniChatApp(apis);
};

void start().catch((error) => {
  failDesktopStartup();
  console.error('[startup] Failed to initialize Mini Chat:', error);
});
