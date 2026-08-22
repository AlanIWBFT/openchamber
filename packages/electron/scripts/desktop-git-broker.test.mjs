import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveDesktopGitBroker } from '../desktop-git-broker.mjs';

test('a CLI override keeps Git on the prepared desktop broker', (t) => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-git-broker-'));
  t.after(() => fs.rmSync(resources, { recursive: true, force: true }));
  const selected = path.join(resources, 'comparison');
  const stage = (dir) => {
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(assets, { recursive: true });
    const file = path.join(assets, 'broker.exe');
    fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify({ processBroker: 'broker.exe' }));
    fs.writeFileSync(file, '');
    return file;
  };
  const comparison = stage(selected);
  const env = { OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: selected };
  assert.equal(resolveDesktopGitBroker(resources, true, env), comparison);
  const cli = { ...env, OPENCODE_BINARY: 'external.exe' };
  assert.equal(resolveDesktopGitBroker(resources, true, cli), null);
  const desktop = stage(path.join(resources, 'opencode-server'));
  assert.equal(resolveDesktopGitBroker(resources, true, cli), desktop);
  assert.equal(resolveDesktopGitBroker(resources, false, env), desktop);
});
