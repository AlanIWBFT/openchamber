import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnterprisePolicy } from '../enterprise-mode.js';
import { requireOpenCodeV2, UnsupportedOpenCodeDistributionError, type OpenCodeCliLaunch } from './compatibility.js';

export const validateSelectedCli = async (value: string, resolveLaunch: (file: string) => OpenCodeCliLaunch) => {
  if (readEnterprisePolicy().opencodeBinary) throw new Error('Your administrator manages the OpenCode CLI.');
  const raw = value.trim().replace(/^(["'])(.*)\1$/, '$2');
  const file = raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const executable = fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()
    ? path.join(file, process.platform === 'win32' ? 'opencode.exe' : 'opencode') : file;
  if (!path.isAbsolute(executable) || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) throw new UnsupportedOpenCodeDistributionError();
  await requireOpenCodeV2(resolveLaunch(executable));
};
