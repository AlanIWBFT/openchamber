import fs from 'node:fs';
import path from 'node:path';

const windowsHelpers = ['OpenCode.Windows.RecycleBin.dll', 'OpenCode.ProcessBroker.exe'];

export const requireOpenCodeNativeHelpers = (binaryPath, platform = process.platform) => {
  if (platform !== 'win32') return [];
  return windowsHelpers.map((name) => {
    const helper = path.join(path.dirname(binaryPath), name);
    if (!fs.statSync(helper, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Local OpenCode CLI is missing its required Windows helper: ${helper}`);
    }
    return helper;
  });
};
