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

test('uses an explicit baseline OpenCode target for Windows ARM64 packages', () => {
  const targetArchitecture = resolveTargetArchitecture({
    platform: 'win32',
    hostArchitecture: 'x64',
    environment: { OPENCHAMBER_TARGET_ARCH: 'arm64' },
  });

  assert.deepEqual(resolveOpenCodeCliTarget({ platform: 'win32', targetArchitecture }), {
    architecture: 'x64',
    buildTarget: 'windows-x64',
    baseline: true,
  });
});

test('uses a non-baseline OpenCode target for native Windows x64 source builds', () => {
  const targetArchitecture = resolveTargetArchitecture({
    platform: 'win32',
    hostArchitecture: 'x64',
    environment: {},
  });

  assert.deepEqual(resolveOpenCodeCliTarget({ platform: 'win32', targetArchitecture }), {
    architecture: 'x64',
    buildTarget: 'windows-x64',
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

test('prefers an explicitly configured OpenCode Bun runtime for source builds', () => {
  const configuredRuntime = path.resolve('fixtures', 'bun-v1.4.0-release', 'bun.exe');

  assert.equal(resolveLocalOpenCodeBunRuntime({
    platform: 'win32',
    targetArchitecture: normalizeTargetArchitecture('arm64'),
    sourceRoot: path.resolve('fixtures', 'opencode'),
    environment: { OPENCHAMBER_OPENCODE_BUN_RUNTIME: configuredRuntime },
  }), configuredRuntime);
});

test('keeps native ARM64 OpenCode targets outside the Windows workaround', () => {
  const targetArchitecture = normalizeTargetArchitecture('arm64');

  assert.deepEqual(resolveOpenCodeCliTarget({ platform: 'darwin', targetArchitecture }), {
    architecture: 'arm64',
    buildTarget: 'darwin-arm64',
    baseline: false,
  });
});
