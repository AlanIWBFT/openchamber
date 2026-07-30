import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeTargetArchitecture,
  readElectronBuilderArchitecture,
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

test('selects one baseline target on every supported x64 platform', () => {
  for (const [platform, target] of [['win32', 'windows'], ['darwin', 'darwin'], ['linux', 'linux']]) {
    assert.deepEqual(resolveOpenCodeCliTarget({ platform, targetArchitecture: normalizeTargetArchitecture('x64') }), {
      architecture: 'x64', buildTarget: `opencode-${target}-x64-baseline`, packageDirectory: `cli-${target}-x64-baseline`, baseline: true,
    });
  }
});
