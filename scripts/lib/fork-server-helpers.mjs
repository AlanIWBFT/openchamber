import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBunExecutable } from './bun-executable.mjs';
import { cachePath, inputIds } from './fork-server-inputs.mjs';

export const windowsServiceHelpers = [
  { key: 'processBroker', pkg: 'util', name: 'windows-process-broker', binary: 'bin/OpenCode.ProcessBroker.exe' },
  { key: 'recycleHelper', pkg: 'core', name: 'windows-recycle', binary: 'bin/Release/netstandard2.0/OpenCode.Windows.RecycleBin.dll' },
];
const project = (h) => `packages/${h.pkg}/src/${h.name}`;
export const helperOutput = (source, h) => path.join(source, project(h), h.binary);

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) return ['bin', 'obj'].includes(entry.name) ? [] : sources(name);
    return /\.(?:cs|csproj|props|targets)$/i.test(entry.name) ? [name] : [];
  });
}

function build(source, helper, env) {
  const args = ['run', '--cwd', path.join(source, 'packages', helper.pkg), `build:${helper.name}`];
  console.log(`[dev] Building ${helper.name}`);
  const childEnv = { ...env };
  delete childEnv.OPENCODE_WINDOWS_PROCESS_BROKER_PREBUILT;
  try {
    execFileSync(resolveBunExecutable({ env }), args, { cwd: source, env: childEnv, windowsHide: true, stdio: 'inherit' });
  } catch (cause) {
    throw new Error(`Could not build ${helper.name}: check the .NET SDK${helper.key === 'processBroker' ? ' and the Visual Studio x64 NativeAOT toolchain' : ''}.`, { cause });
  }
}

export function ensureWindowsServiceHelpers(electron, source, env, prepare = build) {
  const cacheDir = path.dirname(cachePath(electron));
  fs.mkdirSync(cacheDir, { recursive: true });
  for (const helper of windowsServiceHelpers) {
    const pkg = path.join(source, 'packages', helper.pkg);
    const files = [path.join(pkg, 'package.json'), path.join(pkg, 'script', `ensure-${helper.name}.ts`), ...sources(path.join(source, project(helper)))].sort();
    const output = helperOutput(source, helper);
    const cache = path.join(cacheDir, `${helper.name}.json`);
    const inputs = inputIds(files, source, env);
    const record = () => JSON.stringify([files, inputs, inputIds([output], source, env)]);
    if (fs.existsSync(cache) && fs.existsSync(output) && fs.readFileSync(cache, 'utf8') === record()) continue;
    prepare(source, helper, env);
    fs.writeFileSync(cache, record());
  }
}
