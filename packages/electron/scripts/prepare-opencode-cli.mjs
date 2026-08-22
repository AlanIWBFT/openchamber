import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLocalOpenCodeBunRuntime, resolveOpenCodeCliTarget, resolveTargetArchitecture } from './target-architecture.mjs';
import { parseOpenCodeCliVersion, readPinnedOpenCodeCliVersion } from './opencode-cli-version.mjs';
import { requireOpenCodeNativeHelpers } from './opencode-native-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const outputDir = path.join(electronRoot, 'resources', 'opencode-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-cli');

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`Command failed: ${command} ${args.join(' ')}${stderr}${stdout}`);
  }
  return result;
};

/**
 * OpenCode 2.x ships on npm, not as GitHub release assets: `@opencode/cli`
 * resolves a platform package (`@opencode/cli-<os>-<arch>`) whose tarball
 * holds the compiled binary under `package/bin/`. OpenCode's own installer
 * (`https://opencode.ai/v2/install`) downloads exactly these tarballs, so the
 * bundled desktop binary comes from the same place.
 */
const artifactForPlatform = (platform, targetArchitecture) => {
  const arch = targetArchitecture.opencode;
  if (platform === 'darwin') {
    if (arch === 'arm64') return { target: 'darwin-arm64', binary: 'opencode' };
    if (arch === 'x64') return { target: 'darwin-x64-baseline', binary: 'opencode' };
  }
  if (platform === 'win32') {
    if (arch === 'arm64') return { target: 'windows-arm64', binary: 'opencode.exe' };
    if (arch === 'x64') return { target: 'windows-x64-baseline', binary: 'opencode.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { target: 'linux-arm64', binary: 'opencode' };
    if (arch === 'x64') return { target: 'linux-x64-baseline', binary: 'opencode' };
  }
  throw new Error(`No OpenCode CLI artifact mapping for ${platform}/${arch}`);
};

const artifactUrl = (target, version) =>
  `https://registry.npmjs.org/@opencode/cli-${target}/-/cli-${target}-${version}.tgz`;

const outputBinaryPath = (binaryName) => path.join(outputDir, binaryName);

const readBinaryVersion = (binaryPath) => {
  if (!fs.existsSync(binaryPath)) return null;
  const result = spawnSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return parseOpenCodeCliVersion(result.stdout) || null;
};

const ensureExecutable = (filePath) => {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
};

const stageBinary = (source, destination, expectedVersion) => {
  fs.mkdirSync(outputDir, { recursive: true });
  const binaryName = path.basename(destination);
  const temporary = path.join(outputDir, `.next-${process.pid}-${binaryName}`);
  const backup = path.join(outputDir, `.previous-${process.pid}-${binaryName}`);
  fs.rmSync(temporary, { force: true });
  fs.rmSync(backup, { force: true });
  fs.copyFileSync(source, temporary);
  ensureExecutable(temporary);

  const stagedVersion = readBinaryVersion(temporary);
  if (stagedVersion !== expectedVersion) {
    fs.rmSync(temporary, { force: true });
    throw new Error(`Staged OpenCode CLI version mismatch: expected ${expectedVersion}, got ${stagedVersion || 'unknown'}`);
  }

  const hadDestination = fs.existsSync(destination);
  try {
    if (hadDestination) fs.renameSync(destination, backup);
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (hadDestination && fs.existsSync(backup) && !fs.existsSync(destination)) {
      fs.renameSync(backup, destination);
    }
    throw error;
  }
  fs.rmSync(backup, { force: true });

  for (const entry of fs.readdirSync(outputDir)) {
    if (entry === '.gitkeep' || entry === binaryName) continue;
    fs.rmSync(path.join(outputDir, entry), { recursive: true, force: true });
  }
};

const prepareFromLocalSource = ({ sourceRoot, version, targetArchitecture, outputBinary }) => {
  const cliTarget = resolveOpenCodeCliTarget({ platform: process.platform, targetArchitecture });
  const isWindowsArm64Workaround = process.platform === 'win32' && targetArchitecture.node === 'arm64';
  if (targetArchitecture.node !== process.arch && !isWindowsArm64Workaround) {
    throw new Error(
      `Local OpenCode source builds must target the native architecture: host is ${process.arch}, target is ${targetArchitecture.node}`,
    );
  }

  const opencodePackageRoot = path.join(sourceRoot, 'packages', 'cli');
  const opencodePackagePath = path.join(opencodePackageRoot, 'package.json');
  if (!fs.statSync(opencodePackagePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Local OpenCode package not found: ${opencodePackagePath}`);
  }
  const compileExecutablePath = resolveLocalOpenCodeBunRuntime({
    platform: process.platform,
    targetArchitecture,
    sourceRoot,
    environment: process.env,
  });
  if (compileExecutablePath && !fs.statSync(compileExecutablePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Local Bun runtime not found: ${compileExecutablePath}`);
  }

  // Invoke the builder directly so its package script cannot select another Bun from PATH.
  const args = [path.join(opencodePackageRoot, 'script', 'build.ts'), `--target=${cliTarget.buildTarget}`, '--skip-web-ui'];
  if (process.platform === 'win32') args.push('--windows-gui-subsystem');
  const channel = 'dev';
  const environment = {
    ...process.env,
    OPENCODE_CHANNEL: channel,
    OPENCODE_VERSION: version,
  };
  if (compileExecutablePath) environment.OPENCODE_COMPILE_EXECUTABLE_PATH = compileExecutablePath;

  console.log(`[electron] building bundled OpenCode CLI from local source (${channel}): ${sourceRoot}`);
  run(compileExecutablePath || process.env.BUN?.trim() || (process.platform === 'win32' ? 'bun.exe' : 'bun'), args, {
    cwd: sourceRoot,
    env: environment,
    stdio: 'inherit',
  });

  const artifact = artifactForPlatform(process.platform, targetArchitecture);
  const builtBinary = path.join(opencodePackageRoot, 'dist', cliTarget.packageDirectory, 'bin', artifact.binary);
  const helpers = requireOpenCodeNativeHelpers(builtBinary);
  stageBinary(builtBinary, outputBinary, version);
  for (const helper of helpers) {
    fs.copyFileSync(helper, path.join(outputDir, path.basename(helper)));
  }
  console.log(`[electron] prepared local OpenCode CLI ${version}: ${outputBinary}`);
};

const download = async (url, destination) => {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, Buffer.from(await response.arrayBuffer()));
  fs.renameSync(temp, destination);
};

const extractArchive = (archivePath, destination) => {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  // npm tarballs are gzipped tar on every platform; Windows 10+ ships bsdtar.
  // The archive is addressed relative to the destination: under Git Bash on
  // Windows, `tar` is GNU tar, which reads an absolute `D:\...` path as a
  // remote host ("Cannot connect to D:").
  run('tar', ['-xzf', path.relative(destination, archivePath)], { cwd: destination });
};

const findBinary = (root, binaryName) => {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === binaryName.toLowerCase()) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findBinary(fullPath, binaryName);
      if (found) return found;
    }
  }
  return null;
};

const main = async () => {
  const version = process.env.OPENCHAMBER_OPENCODE_CLI_VERSION || readPinnedOpenCodeCliVersion();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid OpenCode CLI version: ${version}`);
  }

  const targetArchitecture = resolveTargetArchitecture();
  const cliTarget = resolveOpenCodeCliTarget({ platform: process.platform, targetArchitecture });
  const artifact = artifactForPlatform(process.platform, targetArchitecture);
  const outputBinary = outputBinaryPath(artifact.binary);
  const localSourceDir = process.env.OPENCHAMBER_OPENCODE_SOURCE_DIR?.trim();
  if (localSourceDir) {
    prepareFromLocalSource({
      sourceRoot: path.resolve(localSourceDir),
      version,
      targetArchitecture,
      outputBinary,
    });
    return;
  }
  const existingVersion = readBinaryVersion(outputBinary);
  if (existingVersion === version) {
    console.log(`[electron] bundled OpenCode CLI already prepared: ${outputBinary} (${version})`);
    return;
  }

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${cliTarget.architecture}`);
  const archiveName = `cli-${artifact.target}-${version}.tgz`;
  const archivePath = path.join(cacheDir, archiveName);
  const url = artifactUrl(artifact.target, version);
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OpenCode CLI ${version}: @opencode/cli-${artifact.target}`);
    await download(url, archivePath);
  } else {
    console.log(`[electron] using cached OpenCode CLI archive: ${archivePath}`);
  }

  const extractDir = path.join(cacheDir, 'extract');
  extractArchive(archivePath, extractDir);
  const extractedBinary = findBinary(extractDir, artifact.binary);
  if (!extractedBinary) {
    throw new Error(`Archive ${archivePath} did not contain ${artifact.binary}`);
  }

  stageBinary(extractedBinary, outputBinary, version);

  const preparedVersion = readBinaryVersion(outputBinary);
  if (preparedVersion !== version) {
    throw new Error(`Prepared OpenCode CLI version mismatch: expected ${version}, got ${preparedVersion || 'unknown'}`);
  }

  console.log(`[electron] prepared OpenCode CLI ${version}: ${outputBinary}`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
