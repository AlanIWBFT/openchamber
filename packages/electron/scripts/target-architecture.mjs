import path from 'node:path';

const ARCHITECTURES = {
  x64: {
    node: 'x64',
    electronBuilder: 'x64',
    opencode: 'x64',
  },
  arm64: {
    node: 'arm64',
    electronBuilder: 'arm64',
    opencode: 'arm64',
  },
};

const ARCHITECTURE_ALIASES = new Map([
  ['x64', 'x64'],
  ['amd64', 'x64'],
  ['x86_64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
]);

const LOCAL_WINDOWS_X64_BUN_RUNTIME = path.join('bun-v1.3.14-shim-hardlink', 'build', 'release', 'bun.exe');

export const normalizeTargetArchitecture = (value, source = 'target architecture') => {
  const normalized = ARCHITECTURE_ALIASES.get(String(value || '').trim().toLowerCase());
  if (!normalized) {
    throw new Error(
      `Unsupported ${source} ${JSON.stringify(value)}. Supported architectures: x64, arm64.`,
    );
  }
  return ARCHITECTURES[normalized];
};

export const readElectronBuilderArchitecture = (args = []) => {
  const requested = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--x64' || argument === '--arm64') requested.push(argument.slice(2));
    if (argument === '--arch' && args[index + 1]) requested.push(args[index + 1]);
    if (argument.startsWith('--arch=')) requested.push(argument.slice('--arch='.length));
  }
  if (requested.length === 0) return null;

  const architectures = new Set(requested.map((value) => normalizeTargetArchitecture(value, 'electron-builder architecture').node));
  if (architectures.size !== 1) {
    throw new Error(`Exactly one Electron target architecture is required, got: ${requested.join(', ')}.`);
  }
  return [...architectures][0];
};

export const resolveTargetArchitecture = ({
  platform = process.platform,
  hostArchitecture = process.arch,
  environment = process.env,
  builderArgs = [],
} = {}) => {
  const host = normalizeTargetArchitecture(hostArchitecture, 'host architecture');
  const builderArchitecture = readElectronBuilderArchitecture(builderArgs);
  const requestedValues = [
    environment.OPENCHAMBER_TARGET_ARCH,
    environment.ELECTRON_BUILDER_ARCH,
    builderArchitecture,
  ].filter(Boolean);
  const requestedArchitectures = new Set(
    requestedValues.map((value) => normalizeTargetArchitecture(value, 'target architecture').node),
  );
  if (requestedArchitectures.size > 1) {
    throw new Error(`Conflicting target architectures: ${requestedValues.join(', ')}.`);
  }

  const target = normalizeTargetArchitecture(requestedValues[0] || host.node);
  if (platform === 'linux' && target.node !== host.node) {
    throw new Error(
      `Linux AppImages must be built natively: host is ${host.node}, target is ${target.node}. `
      + `Run this build on a ${target.node} Linux host.`,
    );
  }
  return target;
};

export const resolveOpenCodeCliTarget = ({ platform = process.platform, targetArchitecture }) => {
  const requestedArchitecture = normalizeTargetArchitecture(targetArchitecture?.opencode, 'OpenCode target architecture').opencode;
  const architecture = platform === 'win32' && requestedArchitecture === 'arm64'
    ? 'x64'
    : requestedArchitecture;
  const buildPlatform = platform === 'win32' ? 'windows' : platform;
  if (!['linux', 'darwin', 'windows'].includes(buildPlatform)) {
    throw new Error(`No OpenCode CLI build target mapping for ${platform}/${architecture}`);
  }
  return {
    architecture,
    buildTarget: `${buildPlatform}-${architecture}`,
    // Native Windows x64 source builds use the patched sibling Bun; ARM64 still needs the x64 baseline workaround.
    baseline: architecture === 'x64' && !(platform === 'win32' && requestedArchitecture === 'x64'),
  };
};

export const resolveLocalOpenCodeBunRuntime = ({ platform = process.platform, targetArchitecture, sourceRoot }) => {
  if (platform !== 'win32' || targetArchitecture?.node !== 'x64') return null;
  return path.resolve(sourceRoot, '..', LOCAL_WINDOWS_X64_BUN_RUNTIME);
};
