import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import afterPack from './scripts/after-pack.cjs';
import { loadWindowsShell } from './windows-shell.mjs';

const appPath = path.dirname(fileURLToPath(import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };

test('Windows shell rejects malformed paths before dispatch', windowsOnly, () => {
  const shell = loadWindowsShell({ isPackaged: false, appPath });
  for (const value of [undefined, null, 123, {}, '', `${appPath}\0ignored`]) {
    assert.throws(() => shell.openDirectory(value), TypeError);
  }
});

test('Windows shell rejects missing directories and never executes a file', windowsOnly, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-shell-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const shell = loadWindowsShell({ isPackaged: false, appPath });
  await assert.rejects(shell.openDirectory(path.join(directory, 'missing')), /Failed to access directory/);

  const marker = path.join(directory, 'executed.txt');
  const script = path.join(directory, 'must-not-run.cmd');
  await fs.writeFile(script, `@echo executed>"${marker}"\r\n`);
  await assert.rejects(shell.openDirectory(script), /Path is not a directory/);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('packaging includes a loadable matching Windows shell module and rejects missing or mismatched output', windowsOnly, async (t) => {
  const appOutDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-shell-package-'));
  t.after(() => fs.rm(appOutDir, { recursive: true, force: true }));
  const context = { electronPlatformName: 'win32', appOutDir, packager: { appInfo: { productFilename: 'OpenChamber' } } };
  await assert.rejects(afterPack(context), /Missing or wrong-architecture/);

  const config = JSON.parse(await fs.readFile(path.join(appPath, 'package.json'), 'utf8'));
  const resource = config.build.win.extraResources.find((entry) => entry.to === 'native/openchamber_shell.node');
  assert.ok(resource, 'Windows packaging must include the native module');
  const resourcesPath = path.join(appOutDir, 'resources');
  const nativePath = path.join(resourcesPath, resource.to);
  await fs.mkdir(path.dirname(nativePath), { recursive: true });
  await fs.copyFile(path.join(appPath, resource.from), nativePath);

  const header = Buffer.alloc(512);
  header.write('MZ');
  header.writeUInt32LE(0x80, 0x3c);
  header.write('PE\0\0', 0x80);
  header.writeUInt16LE(process.arch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
  const executable = path.join(appOutDir, 'OpenChamber.exe');
  await fs.writeFile(executable, header);
  await afterPack(context);

  // Load the copied DLL in a child so its file handle is released before fixture cleanup.
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { loadWindowsShell } from ${JSON.stringify(new URL('./windows-shell.mjs', import.meta.url).href)};
    const shell = loadWindowsShell({ isPackaged: true, resourcesPath: process.argv[1] });
    await assert.rejects(shell.openDirectory(process.argv[2]), /Path is not a directory/);
    console.log('packaged module loaded');
  `, resourcesPath, executable], { encoding: 'utf8', windowsHide: true });
  assert.match(result, /packaged module loaded/);

  header.writeUInt16LE(process.arch === 'arm64' ? 0x8664 : 0xaa64, 0x84);
  await fs.writeFile(executable, header);
  await assert.rejects(afterPack(context), /Missing or wrong-architecture/);
});
