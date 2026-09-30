import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadWindowsShell } from './windows-shell.mjs';

test('DirectWrite discovers installed monospace families without proportional Arial', { skip: process.platform !== 'win32' }, async () => {
  const shell = loadWindowsShell({ isPackaged: false, appPath: path.dirname(fileURLToPath(import.meta.url)) });
  const fonts = await shell.listMonospaceFonts();
  assert.ok(fonts.length > 0);
  assert.ok(fonts.some((font) => font.family === 'Consolas'));
  assert.ok(!fonts.some((font) => font.family === 'Arial'));
  for (const font of fonts) {
    assert.match(font.family, /\S/);
    assert.match(font.label, /\S/);
  }
});
