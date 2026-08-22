import fs from 'fs';
import path from 'path';

const SIMPLE_GIT_SAFE_BINARY_PATTERN = /^([a-z]:)?([a-z0-9/.\\_~-]+)$/i;

const getWindowsGitRuntimeDirectories = (architecture) => architecture === 'arm64'
  ? ['clangarm64', 'mingw64', 'ucrt64', 'mingw32']
  : architecture === 'ia32'
    ? ['mingw32', 'mingw64', 'ucrt64', 'clangarm64']
    : ['mingw64', 'ucrt64', 'clangarm64', 'mingw32'];

export const isExecutableFile = (candidate) => {
  const normalizedCandidate = candidate?.trim();
  if (!normalizedCandidate) {
    return false;
  }
  try {
    const stat = fs.statSync(normalizedCandidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(normalizedCandidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(normalizedCandidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const normalizeGitExecutableCandidate = (candidate) => {
  const trimmed = candidate?.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

export const resolveAutomaticWindowsGitExecutable = (candidate, architecture = process.arch) => {
  const normalized = normalizeGitExecutableCandidate(candidate);
  if (!isExecutableFile(normalized)) {
    return null;
  }

  if (path.basename(normalized).toLowerCase() !== 'git.exe') {
    return normalized;
  }

  const launcherDirectory = path.dirname(normalized);
  const launcherDirectoryName = path.basename(launcherDirectory).toLowerCase();
  if (launcherDirectoryName !== 'cmd' && launcherDirectoryName !== 'bin') {
    return normalized;
  }

  const installRoot = path.dirname(launcherDirectory);
  for (const runtimeDirectory of getWindowsGitRuntimeDirectories(architecture)) {
    const executable = path.join(installRoot, runtimeDirectory, 'bin', 'git.exe');
    if (isExecutableFile(executable)) {
      return executable;
    }
  }

  return normalized;
};

const listPathExecutableCandidates = (environment, binaryName, platform) => {
  const currentPath = environment.PATH || environment.Path || '';
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  const seen = new Set();
  const matches = [];
  for (const segment of currentPath.split(delimiter)) {
    const directory = segment.trim();
    if (!directory || seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    matches.push(path.join(directory, binaryName));
  }
  return matches;
};

const listWindowsGitInstallCandidates = (environment) => {
  const roots = [
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    environment.LocalAppData,
  ]
    .map((value) => value?.trim() || '')
    .filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

const isSafeSimpleGitBinary = (candidate) => SIMPLE_GIT_SAFE_BINARY_PATTERN.test(candidate);

export const createGitBinaryResolver = ({
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
} = {}) => {
  let resolvedGitBinary = null;

  return () => {
    if (platform !== 'win32') {
      return 'git';
    }
    if (resolvedGitBinary) {
      return resolvedGitBinary;
    }

    const explicit = [environment.GIT_BINARY, environment.OPENCHAMBER_GIT_BINARY]
      .map((value) => value?.trim() || '')
      .filter(Boolean);
    for (const candidate of explicit) {
      const normalized = normalizeGitExecutableCandidate(candidate);
      if (isExecutableFile(normalized)) {
        resolvedGitBinary = normalized;
        return resolvedGitBinary;
      }
    }

    const pathDiscovered = [
      ...listPathExecutableCandidates(environment, 'git.exe', platform),
      ...listPathExecutableCandidates(environment, 'git', platform),
    ]
      .map((candidate) => resolveAutomaticWindowsGitExecutable(candidate, architecture))
      .filter(Boolean);
    if (pathDiscovered.length > 0) {
      resolvedGitBinary = pathDiscovered[0];
      return resolvedGitBinary;
    }

    const discovered = listWindowsGitInstallCandidates(environment)
      .map((candidate) => resolveAutomaticWindowsGitExecutable(candidate, architecture))
      .filter(Boolean);
    const preferredExecutable = discovered.find((candidate) => isSafeSimpleGitBinary(candidate) && candidate.toLowerCase().endsWith('.exe'))
      || discovered.find((candidate) => candidate.toLowerCase().endsWith('.exe'));
    resolvedGitBinary = preferredExecutable || discovered[0] || 'git.exe';
    return resolvedGitBinary;
  };
};

export const resolveGitBinary = createGitBinaryResolver();
