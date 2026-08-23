import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  ensureElectronBuilderArchitecture,
  normalizeTargetArchitecture,
  readElectronBuilderArchitecture,
  resolveLocalOpenCodeBunRuntime,
  resolveOpenCodeCliTarget,
  resolveTargetArchitecture,
} from './target-architecture.mjs';

test('normalizes host and release architecture aliases', () => {
  assert.equal(normalizeTargetArchitecture('amd64').node, 'x64');
  assert.equal(normalizeTargetArchitecture('x86_64').electronBuilder, 'x64');
  assert.equal(normalizeTargetArchitecture('aarch64').opencode, 'arm64');
});

test('reads a single electron-builder target architecture', () => {
  assert.equal(readElectronBuilderArchitecture(['--linux', '--arch=aarch64']), 'arm64');
  assert.equal(readElectronBuilderArchitecture(['--linux', '--x64']), 'x64');
});

test('supplies an explicit Electron architecture when Windows or Linux would otherwise infer it from the runtime', () => {
  assert.deepEqual(ensureElectronBuilderArchitecture({
    platform: 'win32',
    targetArchitecture: normalizeTargetArchitecture('arm64'),
    builderArgs: ['--win'],
  }), ['--win', '--arm64']);
  assert.deepEqual(ensureElectronBuilderArchitecture({
    platform: 'linux',
    targetArchitecture: normalizeTargetArchitecture('arm64'),
    builderArgs: ['--arm64'],
  }), ['--arm64']);
});

test('rejects unsupported architectures', () => {
  assert.throws(() => normalizeTargetArchitecture('ia32'), /Supported architectures: x64, arm64/);
});

test('rejects conflicting architecture inputs', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x64',
      environment: { OPENCHAMBER_TARGET_ARCH: 'x64', ELECTRON_BUILDER_ARCH: 'arm64' },
    }),
    /Conflicting target architectures/,
  );
});

test('rejects cross-architecture Linux packaging', () => {
  assert.throws(
    () => resolveTargetArchitecture({
      platform: 'linux',
      hostArchitecture: 'x86_64',
      environment: { OPENCHAMBER_TARGET_ARCH: 'aarch64' },
    }),
    /must be built natively.*host is x64, target is arm64/,
  );
});

test('accepts matching native Linux architecture aliases', () => {
  assert.equal(resolveTargetArchitecture({
    platform: 'linux',
    hostArchitecture: 'x64',
    environment: { OPENCHAMBER_TARGET_ARCH: 'amd64' },
  }).node, 'x64');
});

test('uses an explicit baseline V2 CLI target for Windows ARM64 packages', () => {
  const targetArchitecture = resolveTargetArchitecture({
    platform: 'win32', hostArchitecture: 'x64', environment: { OPENCHAMBER_TARGET_ARCH: 'arm64' },
  });
  assert.deepEqual(resolveOpenCodeCliTarget({ platform: 'win32', targetArchitecture }), {
    architecture: 'x64', buildTarget: 'opencode-windows-x64-baseline', packageDirectory: 'cli-windows-x64-baseline', baseline: true,
  });
});

test('keeps native ARM64 targets outside the Windows workaround', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual(resolveOpenCodeCliTarget({ platform, targetArchitecture: normalizeTargetArchitecture('arm64') }), {
      architecture: 'arm64', buildTarget: `opencode-${platform}-arm64`, packageDirectory: `cli-${platform}-arm64`, baseline: false,
    });
  }
});
test('uses a non-baseline OpenCode target for native Windows x64 source builds', () => {
  const targetArchitecture = resolveTargetArchitecture({
    platform: 'win32',
    hostArchitecture: 'x64',
    environment: {},
  });

  assert.deepEqual(resolveOpenCodeCliTarget({ platform: 'win32', targetArchitecture }), {
    architecture: 'x64',
    buildTarget: 'opencode-windows-x64',
    packageDirectory: 'cli-windows-x64',
    baseline: false,
  });
});

test('resolves the sibling patched Bun runtime only for native Windows x64 source builds', () => {
  const sourceRoot = path.resolve('fixtures', 'opencode');

  assert.equal(
    resolveLocalOpenCodeBunRuntime({
      platform: 'win32',
      targetArchitecture: normalizeTargetArchitecture('x64'),
      sourceRoot,
      environment: {},
    }),
    path.resolve(sourceRoot, '..', 'bun-v1.3.14-shim-hardlink', 'build', 'release', 'bun.exe'),
  );
  assert.equal(resolveLocalOpenCodeBunRuntime({
    platform: 'win32',
    targetArchitecture: normalizeTargetArchitecture('arm64'),
    sourceRoot,
    environment: {},
  }), null);
});

test('selects baseline source targets on non-Windows x64 platforms', () => {
  for (const [platform, target] of [['darwin', 'darwin'], ['linux', 'linux']]) {
    assert.deepEqual(resolveOpenCodeCliTarget({ platform, targetArchitecture: normalizeTargetArchitecture('x64') }), {
      architecture: 'x64', buildTarget: `opencode-${target}-x64-baseline`, packageDirectory: `cli-${target}-x64-baseline`, baseline: true,
    });
  }
});

test('prefers an explicitly configured OpenCode Bun runtime for source builds', () => {
  const configuredRuntime = path.resolve('fixtures', 'bun-v1.4.0-release', 'bun.exe');

  assert.equal(resolveLocalOpenCodeBunRuntime({
    platform: 'win32',
    targetArchitecture: normalizeTargetArchitecture('arm64'),
    sourceRoot: path.resolve('fixtures', 'opencode'),
    environment: { OPENCHAMBER_OPENCODE_BUN_RUNTIME: configuredRuntime },
  }), configuredRuntime);
});

test('an explicit Bun runtime wins over the Windows fallback on every platform', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.equal(resolveLocalOpenCodeBunRuntime({
      platform,
      targetArchitecture: normalizeTargetArchitecture('x64'),
      sourceRoot: path.resolve('fixtures', 'opencode'),
      environment: { OPENCHAMBER_OPENCODE_BUN_RUNTIME: ' ./selected-bun ' },
    }), path.resolve('selected-bun'));
  }
});
