import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

export const loadWindowsShell = ({ isPackaged, resourcesPath, appPath }) => require(isPackaged
  ? path.join(resourcesPath, 'native', 'openchamber_shell.node')
  : path.join(appPath, 'native', 'windows-shell', 'build', 'Release', 'openchamber_shell.node'));
