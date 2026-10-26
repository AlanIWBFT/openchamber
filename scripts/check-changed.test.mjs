import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findRatchetViolations, groupLintFiles, parseOxlintReport } from './check-changed.mjs';

const counts = (entries) => new Map(entries.map(([file, rule, count]) => [`${file}\0${rule}`, count]));

test('large changes lint every file in order without exceeding the Windows argument budget', () => {
  const files = Array.from({ length: 500 }, (_, index) => `C:\\workspace with spaces\\${'nested\\'.repeat(12)}${index}.tsx`);
  const groups = groupLintFiles(files);
  assert.ok(groups.length > 1);
  assert.deepEqual(groups.flat(), files);
  assert.ok(groups.every((group) => group.reduce((length, file) => length + file.length + 3, 0) <= 20_000));
  assert.deepEqual(groupLintFiles([]), []);
});

test('old findings may stay or shrink', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3]])), []);
  assert.deepEqual(findRatchetViolations(base, counts([['a.ts', 'anti-slop(no-runtime-typeof)', 1]])), []);
});

test('code moved into a new shared file is not new', () => {
  const base = counts([['a.js', 'anti-slop(no-runtime-typeof)', 2], ['b.js', 'anti-slop(no-runtime-typeof)', 2]]);
  const current = counts([['shared.js', 'anti-slop(no-runtime-typeof)', 3]]);
  assert.deepEqual(findRatchetViolations(base, current), []);
});

test('a rule that grows across the change is a violation, naming the files it grew in', () => {
  const base = counts([['a.ts', 'anti-slop(no-runtime-typeof)', 3], ['a.ts', 'anti-slop(no-unknown-returns)', 2]]);
  const current = counts([
    ['a.ts', 'anti-slop(no-runtime-typeof)', 1],
    ['a.ts', 'anti-slop(no-unknown-returns)', 2],
    ['new.ts', 'anti-slop(no-unknown-returns)', 1],
  ]);
  assert.deepEqual(findRatchetViolations(base, current), [
    { rule: 'anti-slop(no-unknown-returns)', base: 2, current: 3, files: ['new.ts'] },
  ]);
});

test('a report with no files to lint is no findings, not a broken gate', () => {
  assert.deepEqual(parseOxlintReport('No files found to lint. Please check your paths and ignore patterns.\n'), []);
  const empty = '{\n  "diagnostics": [],\n  "number_of_files": 0\n}\n';
  assert.deepEqual(parseOxlintReport(`No files found to lint.\n${empty}`), []);
  assert.deepEqual(parseOxlintReport(empty), []);
  assert.throws(() => parseOxlintReport(''), /oxlint produced no report/);
});
