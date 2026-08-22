import fs from 'node:fs';
import path from 'node:path';

export const resolveDesktopGitBroker = (resources, dev, env) => {
  const service = (dev && !env.OPENCODE_BINARY && env.OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR) || path.join(resources, 'opencode-server');
  const assets = path.resolve(service, 'assets');
  const manifest = path.join(assets, 'manifest.json');
  if (!fs.existsSync(manifest)) return null;
  const { processBroker } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!processBroker) return null;
  const broker = path.join(assets, processBroker);
  return fs.statSync(broker, { throwIfNoEntry: false })?.isFile() ? broker : null;
};
