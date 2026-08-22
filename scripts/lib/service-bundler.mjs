import fs from 'node:fs';
import path from 'node:path';

export function explicitServiceBundler(env = process.env) {
  const value = env.OPENCHAMBER_OPENCODE_BUN_RUNTIME?.trim();
  if (!value) return null;
  const file = path.resolve(value);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Local Bun runtime not found: ${file}`);
  return fs.realpathSync(file);
}
