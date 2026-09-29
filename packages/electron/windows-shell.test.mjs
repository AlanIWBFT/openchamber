import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import afterPack from './scripts/after-pack.cjs';
import { createInjectedProxyEnvironment, loadWindowsShell, readWindowsEnvironmentSnapshot } from './windows-shell.mjs';

const appPath = path.dirname(fileURLToPath(import.meta.url));
const windowsOnly = { skip: process.platform !== 'win32' };

test('relaunch cleanup lets the next process discover changed or disabled system proxy settings', () => {
  for (const server of ['127.0.0.1:7891', '']) {
    const env = readWindowsEnvironmentSnapshot({
      env: {}, readPaths: () => ({}), readProxy: () => ({ server: '127.0.0.1:7890', bypass: 'old.test' }),
    });
    const injected = createInjectedProxyEnvironment(env);
    for (const [key, value] of Object.entries(env)) injected.remember(key, value);
    injected.clear();
    injected.clear();
    assert.deepEqual(env, { PATH: '' });
    let reads = 0;
    const next = readWindowsEnvironmentSnapshot({
      env, readPaths: () => ({}), readProxy: () => { reads++; return { server, bypass: 'new.test' }; },
    });
    assert.equal(reads, 1);
    assert.equal(next.HTTPS_PROXY, server ? `http://${server}` : undefined);
    assert.equal(next.NO_PROXY, server ? 'new.test,localhost,127.0.0.1,::1' : undefined);
  }
});

test('relaunch cleanup preserves inherited and subsequently changed proxy values', () => {
  const env = { HTTPS_PROXY: 'http://inherited.test', NO_PROXY: '', HTTP_PROXY: 'http://system.test', PATH: 'kept' };
  const injected = createInjectedProxyEnvironment(env);
  injected.remember('HTTP_PROXY', env.HTTP_PROXY);
  injected.remember('PATH', env.PATH);
  env.HTTP_PROXY = 'http://changed.test';
  injected.clear();
  assert.deepEqual(env, { HTTPS_PROXY: 'http://inherited.test', NO_PROXY: '', HTTP_PROXY: 'http://changed.test', PATH: 'kept' });
  // Cleared ownership must not delete a later value that happens to match the old default.
  env.HTTP_PROXY = 'http://system.test';
  injected.clear();
  assert.equal(env.HTTP_PROXY, 'http://system.test');
});

test('relaunch cleanup tolerates already removed and mixed-case injected variables', () => {
  const env = { https_proxy: 'http://system.test', No_Proxy: 'localhost' };
  const injected = createInjectedProxyEnvironment(env);
  injected.remember('https_proxy', env.https_proxy);
  injected.remember('No_Proxy', env.No_Proxy);
  delete env.https_proxy;
  injected.clear();
  assert.deepEqual(env, {});
});

test('Windows environment preserves inherited values and expands registry PATH case-insensitively', () => {
  const env = { Path: 'C:\\Inherited', SystemRoot: 'C:\\Windows', CUSTOM: 'kept' };
  const snapshot = readWindowsEnvironmentSnapshot({
    env, commonPaths: ['C:\\Tools'],
    readPaths: () => ({ machine: '%SYSTEMROOT%\\System32', user: 'C:\\User' }),
    readProxy: () => ({ server: '', bypass: '' }),
  });
  assert.deepEqual(snapshot, { SystemRoot: 'C:\\Windows', CUSTOM: 'kept', PATH: 'C:\\Windows\\System32;C:\\User;C:\\Inherited;C:\\Tools' });
  assert.equal(env.Path, 'C:\\Inherited');
});

test('Windows environment falls back without a probe process when the addon cannot be loaded', () => {
  const snapshot = readWindowsEnvironmentSnapshot({
    isPackaged: false, appPath: path.join(appPath, 'missing-addon'),
    env: { Path: 'C:\\Inherited', CUSTOM: 'kept' }, commonPaths: ['C:\\Tools'],
  });
  assert.deepEqual(snapshot, { CUSTOM: 'kept', PATH: 'C:\\Inherited;C:\\Tools' });
});

test('Windows native environment reader exposes raw registry paths', windowsOnly, () => {
  const shell = loadWindowsShell({ isPackaged: false, appPath });
  const paths = shell.readEnvironmentPaths();
  assert.match(paths.machine, /.*/s);
  assert.match(paths.user, /.*/s);
  const snapshot = readWindowsEnvironmentSnapshot({ isPackaged: false, appPath });
  assert.match(snapshot.PATH, /.*/s);
  assert.ok(snapshot.PATH.length > 0);
});

test('Windows system proxy supplies HTTP and HTTPS defaults without mutating inherited values', () => {
  const env = { Path: 'C:\\Inherited' };
  const snapshot = readWindowsEnvironmentSnapshot({
    env, readPaths: () => ({}), readProxy: () => ({ server: '127.0.0.1:7890;', bypass: '' }),
  });
  assert.deepEqual(snapshot, {
    PATH: 'C:\\Inherited', HTTP_PROXY: 'http://127.0.0.1:7890', HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1,::1',
  });
  assert.deepEqual(env, { Path: 'C:\\Inherited' });
});

test('Windows system proxy translates protocol maps and compatible exclusions', () => {
  const snapshot = readWindowsEnvironmentSnapshot({
    env: {}, readPaths: () => ({}),
    readProxy: () => ({ server: 'http=proxy.test:80;https=https://secure.test:443;socks=localhost:1080;', bypass: '*.example.com;intranet.test;<local>;10.*' }),
  });
  assert.deepEqual(snapshot, {
    PATH: '', HTTP_PROXY: 'http://proxy.test:80', HTTPS_PROXY: 'https://secure.test:443', NO_PROXY: '.example.com,intranet.test,localhost,127.0.0.1,::1',
  });
  const httpsOnly = readWindowsEnvironmentSnapshot({
    env: {}, readPaths: () => ({}), readProxy: () => ({ server: 'https=proxy.test:80', bypass: '' }),
  });
  assert.equal(httpsOnly.HTTP_PROXY, undefined);
  assert.equal(httpsOnly.HTTPS_PROXY, 'http://proxy.test:80');
});

test('explicit proxy environment skips native proxy discovery, even when empty or mixed-case', () => {
  for (const key of ['HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'ws_proxy', 'Wss_Proxy']) {
    for (const value of ['', 'http://explicit.test:8080']) {
      let reads = 0;
      const snapshot = readWindowsEnvironmentSnapshot({
        env: { [key]: value }, readPaths: () => ({}),
        readProxy: () => { reads++; return { server: 'system.test:80', bypass: '' }; },
      });
      assert.equal(reads, 0);
      assert.deepEqual(snapshot, { [key]: value, PATH: '' });
    }
  }
});

test('explicit proxy exclusions retain their spelling and value', () => {
  for (const key of ['NO_PROXY', 'no_proxy', 'No_Proxy']) {
    for (const value of ['', '*', 'explicit.test']) {
      const snapshot = readWindowsEnvironmentSnapshot({
        env: { [key]: value }, readPaths: () => ({}), readProxy: () => ({ server: 'proxy.test:80', bypass: 'registry.test' }),
      });
      assert.deepEqual(snapshot, { [key]: value, PATH: '', HTTP_PROXY: 'http://proxy.test:80', HTTPS_PROXY: 'http://proxy.test:80' });
    }
  }
});

test('disabled, invalid, SOCKS-only and failed proxy discovery preserve the environment', () => {
  for (const server of ['', 'bad host:80', 'socks=localhost:1080', 'socks5://localhost:1080']) {
    assert.deepEqual(readWindowsEnvironmentSnapshot({
      env: { CUSTOM: 'kept' }, readPaths: () => ({ machine: 'C:\\Tools' }), readProxy: () => ({ server, bypass: '' }),
    }), { CUSTOM: 'kept', PATH: 'C:\\Tools' });
  }
  assert.deepEqual(readWindowsEnvironmentSnapshot({
    env: { CUSTOM: 'kept' }, readPaths: () => ({ machine: 'C:\\Tools' }), readProxy: () => { throw new Error('unavailable'); },
  }), { CUSTOM: 'kept', PATH: 'C:\\Tools' });
});

test('Windows native proxy reader returns the current user configuration', windowsOnly, () => {
  const proxy = loadWindowsShell({ isPackaged: false, appPath }).readSystemProxy();
  assert.match(proxy.server, /.*/s);
  assert.match(proxy.bypass, /.*/s);
});

test('Bun child uses the discovered proxy for outbound HTTP and bypasses loopback', async (t) => {
  const requests = [];
  const proxy = createServer((request, response) => { requests.push(request.url); response.end('proxied'); });
  const direct = createServer((_request, response) => response.end('direct'));
  t.after(() => { proxy.closeAllConnections(); proxy.close(); direct.closeAllConnections(); direct.close(); });
  await Promise.all([proxy, direct].map((server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|wss?|no)_proxy$/i.test(key)));
  const snapshot = readWindowsEnvironmentSnapshot({
    env, readPaths: () => ({}), readProxy: () => ({ server: `127.0.0.1:${proxy.address().port}`, bypass: '' }),
  });
  const script = `console.log(await (await fetch('http://opencode-proxy-test.invalid/probe')).text()); console.log(await (await fetch('http://127.0.0.1:${direct.address().port}/')).text());`;
  const stdout = await new Promise((resolve, reject) => execFile('bun', ['--eval', script], {
    env: snapshot, windowsHide: true, timeout: 10_000,
  }, (error, stdout, stderr) => {
    if (error) { reject(error); return; }
    assert.equal(stderr, '');
    resolve(stdout);
  }));
  assert.deepEqual(stdout.trim().split(/\r?\n/), ['proxied', 'direct']);
  assert.deepEqual(requests, ['http://opencode-proxy-test.invalid/probe']);
});

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
    assert.match(shell.readSystemProxy().server, /.*/s);
    await assert.rejects(shell.openDirectory(process.argv[2]), /Path is not a directory/);
    console.log('packaged module loaded');
  `, resourcesPath, executable], { encoding: 'utf8', windowsHide: true });
  assert.match(result, /packaged module loaded/);

  header.writeUInt16LE(process.arch === 'arm64' ? 0x8664 : 0xaa64, 0x84);
  await fs.writeFile(executable, header);
  await assert.rejects(afterPack(context), /Missing or wrong-architecture/);
});
