import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { explicitServiceBundler } from './service-bundler.mjs';

export const sourceRootFor = (repo, env) => fs.realpathSync(env.OPENCHAMBER_OPENCODE_SOURCE_DIR || path.resolve(repo, '..', 'opencode'));
export const cachePath = (electron) => path.join(electron, '.cache', 'opencode-server', 'fork-inputs.json');

const hashLines = (output, count) => {
  const hashes = [...output.matchAll(/^\\?([0-9a-f]{32})\s/gim)].map(match => match[1]);
  if (hashes.length !== count) throw new Error('xxhsum did not hash every OpenCode bundle input');
  return hashes;
};
export function inputIds(files, cwd, env = process.env) {
  const options = { cwd, env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 };
  const usage = spawnSync('xxhsum', ['--help'], options);
  if (usage.error?.code === 'ENOENT') {
    const input = files.map(file => JSON.stringify(file.split(path.sep).join('/'))).join('\n') + '\n';
    return 'git-blob\n' + execFileSync('git', ['hash-object', '--no-filters', '--stdin-paths'], { ...options, input }).trimEnd();
  }
  if (usage.error) throw usage.error;
  if (`${usage.stdout}${usage.stderr}`.includes('--files-from') && files.every(file => !/[\r\n]/.test(file))) {
    const input = files.join('\n') + '\n';
    return 'xxh3-128\n' + hashLines(execFileSync('xxhsum', ['-H2', '--files-from', '-'], { ...options, input }), files.length).join('\n');
  }
  // Bound argv for CreateProcess and older Linux xxhsum without --files-from.
  const ids = [];
  for (let start = 0; start < files.length;) {
    let end = start + 1;
    let length = files[start].length + 3;
    while (end < files.length && length + files[end].length + 3 < 24_000) length += files[end++].length + 3;
    ids.push(...hashLines(execFileSync('xxhsum', ['-H2', ...files.slice(start, end)], options), end - start));
    start = end;
  }
  return `xxh3-128\n${ids.join('\n')}`;
}

export function forkInputsCurrent(electron, source, manifest, bundler = explicitServiceBundler()) {
  if (!manifest?.fork) return false;
  try {
    const record = JSON.parse(fs.readFileSync(cachePath(electron), 'utf8'));
    return (record.bundler ?? null) === bundler && record.root === source && record.stamp === manifest.fork.stamp && record.ids === inputIds(record.files, source);
  } catch {
    return false;
  }
}

export function recordForkInputs(electron, source, inputs, extra, bundler = explicitServiceBundler()) {
  const files = new Set(extra);
  if (bundler) files.add(bundler);
  for (const input of inputs) {
    const file = path.resolve(input);
    if (!fs.statSync(file).isFile()) throw new Error(`Missing bundled input: ${file}`);
    files.add(file);
  }
  const directories = new Set();
  for (const file of files) {
    let parent = path.dirname(file);
    while (!directories.has(parent)) {
      directories.add(parent);
      const manifest = path.join(parent, 'package.json');
      if (fs.existsSync(manifest)) files.add(manifest);
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
  const sorted = [...files].sort();
  const ids = inputIds(sorted, source);
  const stamp = execFileSync('git', ['hash-object', '--stdin'], { cwd: source, input: JSON.stringify([sorted, ids]), encoding: 'utf8', windowsHide: true }).trim();
  const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: source, encoding: 'utf8', windowsHide: true }).trim();
  const dest = cachePath(electron);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ root: source, stamp, ids, files: sorted, bundler }));
  return { commit, stamp };
}
