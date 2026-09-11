import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTargetArchitecture } from './target-architecture.mjs';

if (process.platform === 'win32') {
  const require = createRequire(import.meta.url);
  const rebuildRequire = createRequire(require.resolve('@electron/rebuild'));
  const nodeGyp = rebuildRequire.resolve('node-gyp/bin/node-gyp.js');
  const electronVersion = require('electron/package.json').version;
  const architecture = resolveTargetArchitecture().electronBuilder;
  const directory = fileURLToPath(new URL('../native/windows-shell', import.meta.url));
  console.log(`[electron] building Windows shell module for Electron ${electronVersion} (${architecture})`);
  execFileSync(process.execPath, [
    nodeGyp, 'rebuild',
    `--directory=${directory}`,
    `--target=${electronVersion}`,
    `--arch=${architecture}`,
    '--dist-url=https://www.electronjs.org/headers',
    `--devdir=${path.join(os.homedir(), '.electron-gyp')}`,
    '--msvs_version=2022',
  ], { stdio: 'inherit', windowsHide: true });
}
