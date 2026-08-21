import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requireOpenCodeNativeHelpers } from './opencode-native-helpers.mjs';

test('Windows local bundles require both native companions before staging', (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-native-helpers-'));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const binary = path.join(directory, 'opencode.exe');
  assert.throws(() => requireOpenCodeNativeHelpers(binary, 'win32'), /RecycleBin\.dll/);
  fs.writeFileSync(path.join(directory, 'OpenCode.Windows.RecycleBin.dll'), 'fixture');
  assert.throws(() => requireOpenCodeNativeHelpers(binary, 'win32'), /ProcessBroker\.exe/);
  fs.writeFileSync(path.join(directory, 'OpenCode.ProcessBroker.exe'), 'fixture');
  const helpers = requireOpenCodeNativeHelpers(binary, 'win32');
  assert.equal(helpers.length, 2);
  assert.ok(helpers.every((helper) => path.dirname(helper) === directory && fs.statSync(helper).isFile()));
});

test('non-Windows local bundles do not require Windows artifacts', () => {
  for (const platform of ['linux', 'darwin']) {
    assert.deepEqual(requireOpenCodeNativeHelpers('/not-staged/opencode', platform), []);
  }
});
