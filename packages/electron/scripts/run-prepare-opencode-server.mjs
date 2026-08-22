import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';
import { explicitServiceBundler } from '../../../scripts/lib/service-bundler.mjs';

const bun = explicitServiceBundler() ?? resolveBunExecutable();
const entry = fileURLToPath(new URL('./prepare-opencode-server.mjs', import.meta.url));
const result = spawnSync(bun, [entry, ...process.argv.slice(2)], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
