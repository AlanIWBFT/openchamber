import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const createInjectedProxyEnvironment = (env) => {
  const injected = new Map();
  return {
    remember(key, value) {
      if (/^(https?|all|wss?|no)_proxy$/i.test(key)) injected.set(key, value);
    },
    clear() {
      for (const [key, value] of injected) {
        if (env[key] === value) delete env[key];
      }
      injected.clear();
    },
  };
};

export const loadWindowsShell = ({ isPackaged, resourcesPath, appPath }) => require(isPackaged
  ? path.join(resourcesPath, 'native', 'openchamber_shell.node')
  : path.join(appPath, 'native', 'windows-shell', 'build', 'Release', 'openchamber_shell.node'));

export const readWindowsEnvironmentSnapshot = ({ env = process.env, commonPaths = [], readPaths, readProxy, ...location }) => {
  let registry = {};
  try {
    registry = (readPaths ?? (() => loadWindowsShell(location).readEnvironmentPaths()))();
  } catch {
    // A missing addon or inaccessible registry must not prevent startup.
  }
  const values = new Map(Object.entries(env).map(([key, value]) => [key.toLowerCase(), value]));
  const expand = (value) => String(value || '').replace(/%([^%]+)%/g, (match, key) => values.get(key.toLowerCase()) ?? match);
  const snapshot = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'path'));
  snapshot.PATH = [registry.machine, registry.user, values.get('path'), ...commonPaths].map(expand).filter(Boolean).join(';');
  if (['http_proxy', 'https_proxy', 'all_proxy', 'ws_proxy', 'wss_proxy'].some((key) => values.has(key) && values.get(key) !== undefined)) return snapshot;
  try {
    const proxy = (readProxy ?? (() => loadWindowsShell(location).readSystemProxy()))();
    const servers = new Map();
    for (const entry of proxy.server.split(';')) {
      if (!entry.trim()) continue;
      const parts = entry.trim().match(/^(http|https)\s*=\s*(.+)$/i);
      if (parts) {
        servers.set(parts[1].toLowerCase(), parts[2]);
      } else if (!entry.includes('=')) {
        servers.set('http', entry.trim());
        servers.set('https', entry.trim());
      }
    }
    let applied = false;
    for (const protocol of ['http', 'https']) {
      const value = servers.get(protocol);
      if (!value) continue;
      const url = value.includes('://') ? value : `http://${value}`;
      if (!URL.canParse(url) || !['http:', 'https:'].includes(new URL(url).protocol)) continue;
      snapshot[`${protocol.toUpperCase()}_PROXY`] = url;
      applied = true;
    }
    if (applied && values.get('no_proxy') === undefined) {
      // WinINET's <local> and arbitrary wildcards have no portable NO_PROXY equivalent.
      const bypass = proxy.bypass.split(';').map((entry) => entry.trim().replace(/^\*\./, '.'))
        .filter((entry) => entry && !/[<>*?]/.test(entry));
      snapshot.NO_PROXY = [...bypass, 'localhost', '127.0.0.1', '::1'].join(',');
    }
  } catch {
    // An unavailable native reader must not prevent startup or discard the PATH snapshot.
  }
  return snapshot;
};
