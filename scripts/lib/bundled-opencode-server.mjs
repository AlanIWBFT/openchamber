// The OpenCode server the desktop app bundles, staged from this checkout, for dev tooling that needs the
// pinned OpenCode rather than whatever `opencode` is on PATH. The web server runs it when
// OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR names the folder (packages/electron/opencode-server).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveBunExecutable } from './bun-executable.mjs';
import { explicitServiceBundler } from './service-bundler.mjs';
import { forkInputsCurrent, sourceRootFor } from './fork-server-inputs.mjs';
import { ensureWindowsServiceHelpers } from './fork-server-helpers.mjs';

// Bundling takes seconds and the native packages are small; past this, the network is the problem.
const PREPARE_TIMEOUT_MS = 180_000;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const stagedFor = (dir, version) => {
  const manifestPath = path.join(dir, 'assets', 'manifest.json');
  try {
    if (!fs.statSync(path.join(dir, 'serve.mjs')).isFile()) return null;
    const manifest = readJson(manifestPath);
    return manifest.version === version && manifest.platform === process.platform && manifest.arch === process.arch ? manifest : null;
  } catch {
    return null;
  }
};

// Stages the server for this machine when the checkout has none, or one for another version or target.
// A failure throws at once with what to run by hand: preparing downloads the native packages from npm.
export const ensureBundledOpenCodeServer = (repoRoot, source, callerEnv = process.env) => {
  const bundler = explicitServiceBundler(callerEnv);
  const electronDir = path.join(repoRoot, 'packages', 'electron');
  const dir = path.join(electronDir, 'resources', 'opencode-server');
  const version = readJson(path.join(electronDir, 'package.json')).devDependencies['@opencode/server'];
  if (source && process.platform === 'win32') ensureWindowsServiceHelpers(electronDir, source, callerEnv);
  const current = () => {
    const manifest = stagedFor(dir, version);
    return manifest && (!source || forkInputsCurrent(electronDir, source, manifest, bundler));
  };
  if (current()) return dir;
  const env = { ...callerEnv };
  if (bundler) env.OPENCHAMBER_OPENCODE_BUN_RUNTIME = bundler;
  if (source) env.OPENCHAMBER_OPENCODE_SOURCE_DIR = source;
  delete env.OPENCHAMBER_TARGET_ARCH;
  delete env.ELECTRON_BUILDER_ARCH;
  delete env.OPENCHAMBER_OPENCODE_SERVER_PLATFORM;
  const result = spawnSync(bundler ?? resolveBunExecutable({ env }), ['./scripts/prepare-opencode-server.mjs'], {
    cwd: electronDir,
    env,
    encoding: 'utf8',
    timeout: PREPARE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || !current()) {
    const reason = result.error?.code === 'ETIMEDOUT'
      ? `it did not finish in ${PREPARE_TIMEOUT_MS / 1000} s`
      : (result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n').slice(-3).join(' '));
    throw new Error(`Could not prepare the bundled OpenCode server ${version} (${reason}). It downloads native packages from npm: `
      + 'run `bun run --cwd packages/electron prepare:opencode-server` with network access, or set OPENCODE_BINARY to an OpenCode CLI.');
  }
  return dir;
};

// An explicit selection is a comparison target, even when its producing checkout has moved on.
export function devOpenCodeEnv(repoRoot, callerEnv = process.env) {
  if (callerEnv.OPENCODE_BINARY) {
    const cli = path.resolve(callerEnv.OPENCODE_BINARY);
    if (!fs.statSync(cli, { throwIfNoEntry: false })?.isFile() ||
        (process.platform === 'win32' && !/\.(exe|com|bat|cmd)$/i.test(cli))) {
      throw new Error(`OPENCODE_BINARY does not name an executable CLI: ${cli}`);
    }
    fs.accessSync(cli, fs.constants.X_OK);
    console.log(`[dev] OpenCode CLI: ${cli}`);
    return { OPENCODE_BINARY: cli, OPENCHAMBER_DEV_OPENCODE_ENTRY: cli };
  }
  const explicit = callerEnv.OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR;
  const dir = explicit ? path.resolve(explicit) : ensureBundledOpenCodeServer(repoRoot, sourceRootFor(repoRoot, callerEnv), callerEnv);
  const version = readJson(path.join(repoRoot, 'packages/electron/package.json')).devDependencies['@opencode/server'];
  const manifest = stagedFor(dir, version);
  if (!manifest?.fork?.commit || !manifest.fork.stamp) {
    throw new Error(`Expected a fork OpenCode server ${version} for ${process.platform}-${process.arch} in ${dir}`);
  }
  console.log(`[dev] ${explicit ? 'Selected' : 'Worktree'} OpenCode server ${version} (${manifest.fork.commit}): ${dir}`);
  return { OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: dir, OPENCHAMBER_DEV_OPENCODE_ENTRY: path.join(dir, 'serve.mjs') };
}
