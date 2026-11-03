import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { validateLocalPath } from './path-open-utils.mjs';

test('local path validation preserves whitespace in an absolute filename', async () => {
  const target = path.resolve('report.md  ');
  const stats = { isDirectory: () => false };
  const checked = [];
  mock.method(fsp, 'stat', async (value) => { checked.push(value); return stats; });
  mock.method(fsp, 'access', async (value) => { checked.push(value); });
  try {
    assert.deepEqual(await validateLocalPath(target), { path: target, stats });
    assert.deepEqual(checked, [target, target]);
    await assert.rejects(validateLocalPath('   '), /Path is required/);
  } finally {
    mock.restoreAll();
  }
});
