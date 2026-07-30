import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { devOpenCodeEnv, ensureBundledOpenCodeServer } from './bundled-opencode-server.mjs';

test('a CLI the caller names wins and nothing is prepared', () => {
  const env = devOpenCodeEnv('missing checkout', { OPENCODE_BINARY: process.execPath, OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: 'unused' });
  assert.deepEqual(env, { OPENCODE_BINARY: process.execPath });
});

test('invalid explicit CLI never falls back to another backend', () => {
  assert.throws(() => devOpenCodeEnv('.', { OPENCODE_BINARY: os.tmpdir() }), /does not name an executable CLI/);
});

test('an explicit service must be a fork of the pinned version but need not have the latest commit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-selected-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'service');
  const cfg = { OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: dir };
  fs.mkdirSync(path.join(root, 'packages/electron'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/electron/package.json'), JSON.stringify({ devDependencies: { '@opencode/server': '2.3.2' } }));
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'serve.mjs'), '');
  const manifest = (version, fork) => fs.writeFileSync(path.join(dir, 'assets/manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, version, fork }));
  manifest('2.3.2');
  assert.throws(() => devOpenCodeEnv(root, cfg), /Expected a fork/);
  manifest('2.3.0', { commit: 'older', stamp: 'abc' });
  assert.throws(() => devOpenCodeEnv(root, cfg), /Expected a fork/);
  manifest('2.3.2', { commit: 'older', stamp: 'abc' });
  assert.deepEqual(devOpenCodeEnv(root, cfg), cfg);
});

test('a failed preparation stops at once and says what to run', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-bundled-opencode-'));
  try {
    const electron = path.join(root, 'packages', 'electron');
    fs.mkdirSync(path.join(electron, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ devDependencies: { '@opencode/server': '2.3.0' } }));
    fs.writeFileSync(path.join(electron, 'scripts', 'prepare-opencode-server.mjs'), 'console.error("getaddrinfo ENOTFOUND registry.npmjs.org"); process.exit(1)\n');
    assert.throws(
      () => ensureBundledOpenCodeServer(root),
      /Could not prepare the bundled OpenCode server 2\.3\.0 \(.*ENOTFOUND registry\.npmjs\.org.*\).*prepare:opencode-server.*OPENCODE_BINARY/s,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
