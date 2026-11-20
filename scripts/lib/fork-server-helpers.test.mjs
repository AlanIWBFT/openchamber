import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureWindowsServiceHelpers, helperOutput, windowsServiceHelpers } from './fork-server-helpers.mjs';

test('HMR rebuilds only the helper with changed sources or a missing binary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-native-inputs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  for (const h of windowsServiceHelpers) {
    const pkg = path.join(root, 'packages', h.pkg);
    write(path.join(pkg, 'package.json'), '{}');
    write(path.join(pkg, 'script', `ensure-${h.name}.ts`), 'build');
    write(path.join(pkg, 'src', h.name, 'source.cs'), 'A');
  }
  const builds = [];
  const ensure = () => ensureWindowsServiceHelpers(root, root, process.env, (_, helper) => {
    builds.push(helper.key);
    write(helperOutput(root, helper), 'binary');
  });
  ensure();
  ensure();
  assert.deepEqual(builds.splice(0), ['processBroker', 'recycleHelper']);
  write(path.join(root, 'packages/core/src/windows-recycle/another.cs'), 'B');
  ensure();
  assert.deepEqual(builds.splice(0), ['recycleHelper']);
  fs.renameSync(helperOutput(root, windowsServiceHelpers[0]), path.join(root, 'moved.exe'));
  ensure();
  assert.deepEqual(builds, ['processBroker']);
});
