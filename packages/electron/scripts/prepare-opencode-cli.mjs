import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOpenCodeCliTarget, resolveTargetArchitecture } from './target-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(electronRoot, '../..');
const outputDir = path.join(electronRoot, 'resources', 'opencode-cli');
const cacheRoot = path.join(electronRoot, '.cache', 'opencode-cli');
const rootPackagePath = path.join(workspaceRoot, 'package.json');
const shutdownProtocolMarker = 'openchamber-shutdown-protocol.capability';
const legacySqliteFinalizerMarker = 'openchamber-sqlite-finalizer.capability';
const windowsRecycleHelper = 'OpenCode.Windows.RecycleBin.dll';

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

const readPinnedSdkVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
  const version = pkg.dependencies?.['@opencode-ai/sdk'];
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error('Missing @opencode-ai/sdk dependency in root package.json');
  }
  const trimmed = version.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmed)) {
    throw new Error(`@opencode-ai/sdk must be pinned to an exact version for desktop CLI bundling, got: ${trimmed}`);
  }
  return trimmed;
};

const artifactForPlatform = (platform, targetArchitecture) => {
  const arch = resolveOpenCodeCliTarget({ platform, targetArchitecture }).architecture;
  if (platform === 'darwin') {
    if (arch === 'arm64') return { name: 'opencode-darwin-arm64.zip', binary: 'opencode' };
    if (arch === 'x64') return { name: 'opencode-darwin-x64-baseline.zip', binary: 'opencode' };
  }
  if (platform === 'win32') {
    if (arch === 'x64') return { name: 'opencode-windows-x64-baseline.zip', binary: 'opencode.exe' };
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return { name: 'opencode-linux-arm64.tar.gz', binary: 'opencode' };
    if (arch === 'x64') return { name: 'opencode-linux-x64-baseline.tar.gz', binary: 'opencode' };
  }
  throw new Error(`No OpenCode CLI artifact mapping for ${platform}/${arch}`);
};

const localArtifactForPlatform = (platform, targetArchitecture) => {
  const artifact = artifactForPlatform(platform, targetArchitecture);
  return {
    binary: artifact.binary,
    directory: artifact.name.replace(/\.(?:zip|tar\.gz)$/, ''),
  };
};

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
  return (result.stdout || '').trim().split(/\s+/)[0] || null;
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

  const opencodePackageRoot = path.join(sourceRoot, 'packages', 'opencode');
  const opencodePackagePath = path.join(opencodePackageRoot, 'package.json');
  if (!fs.statSync(opencodePackagePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Local OpenCode package not found: ${opencodePackagePath}`);
  }

  const args = ['run', '--cwd', opencodePackageRoot, 'build', '--single', `--target=${cliTarget.buildTarget}`];
  if (cliTarget.baseline) args.push('--baseline');
  args.push('--skip-embed-web-ui');
  const channel = 'dev';

  console.log(`[electron] building bundled OpenCode CLI from local source (${channel}): ${sourceRoot}`);
  run(process.env.BUN?.trim() || (process.platform === 'win32' ? 'bun.exe' : 'bun'), args, {
    cwd: sourceRoot,
    env: {
      ...process.env,
      OPENCODE_CHANNEL: channel,
      OPENCODE_VERSION: version,
    },
    stdio: 'inherit',
  });

  const artifact = localArtifactForPlatform(process.platform, targetArchitecture);
  const builtBinary = path.join(sourceRoot, 'packages', 'opencode', 'dist', artifact.directory, 'bin', artifact.binary);
  const builtMarker = path.join(path.dirname(builtBinary), shutdownProtocolMarker);
  if (!fs.statSync(builtMarker, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Local OpenCode build is missing shutdown protocol capability marker: ${builtMarker}`);
  }
  const builtRecycleHelper = path.join(path.dirname(builtBinary), windowsRecycleHelper);
  if (process.platform === 'win32' && !fs.statSync(builtRecycleHelper, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Local OpenCode build is missing Windows Recycle Bin helper: ${builtRecycleHelper}`);
  }
  stageBinary(builtBinary, outputBinary, version);
  if (process.platform === 'win32') {
    fs.copyFileSync(builtRecycleHelper, path.join(outputDir, windowsRecycleHelper));
  }
  fs.copyFileSync(builtMarker, path.join(outputDir, shutdownProtocolMarker));
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
  if (archivePath.endsWith('.zip')) {
    if (process.platform === 'win32') {
      run('powershell.exe', [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath ${JSON.stringify(archivePath)} -DestinationPath ${JSON.stringify(destination)} -Force`,
      ]);
      return;
    }
    run('unzip', ['-q', archivePath, '-d', destination]);
    return;
  }
  if (archivePath.endsWith('.tar.gz')) {
    run('tar', ['-xzf', archivePath, '-C', destination]);
    return;
  }
  throw new Error(`Unsupported OpenCode CLI archive: ${archivePath}`);
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
  const version = process.env.OPENCHAMBER_OPENCODE_CLI_VERSION || readPinnedSdkVersion();
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
    fs.rmSync(path.join(outputDir, shutdownProtocolMarker), { force: true });
    fs.rmSync(path.join(outputDir, legacySqliteFinalizerMarker), { force: true });
    console.log(`[electron] bundled OpenCode CLI already prepared: ${outputBinary} (${version})`);
    return;
  }

  const cacheDir = path.join(cacheRoot, version, `${process.platform}-${cliTarget.architecture}`);
  const archivePath = path.join(cacheDir, artifact.name);
  const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${artifact.name}`;
  if (!fs.existsSync(archivePath)) {
    console.log(`[electron] downloading OpenCode CLI ${version}: ${artifact.name}`);
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
  fs.rmSync(path.join(outputDir, shutdownProtocolMarker), { force: true });
  fs.rmSync(path.join(outputDir, legacySqliteFinalizerMarker), { force: true });

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
