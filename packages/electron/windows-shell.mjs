import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const loadWindowsShell = ({ isPackaged, resourcesPath, appPath }) => require(isPackaged
  ? path.join(resourcesPath, 'native', 'openchamber_shell.node')
  : path.join(appPath, 'native', 'windows-shell', 'build', 'Release', 'openchamber_shell.node'));

export const readWindowsEnvironmentSnapshot = ({ env = process.env, commonPaths = [], readPaths, ...location }) => {
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
  return snapshot;
};
