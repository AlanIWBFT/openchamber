import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitBinaryResolver,
  normalizeGitExecutableCandidate,
  resolveAutomaticWindowsGitExecutable,
} from './git-binary.js';

const tempDirectories = [];

const createExecutable = (root, relativePath) => {
  const executable = path.join(root, ...relativePath);
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '');
  fs.chmodSync(executable, 0o755);
  return executable;
};

const createInstallRoot = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-binary-'));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveAutomaticWindowsGitExecutable', () => {
  it('resolves the cmd launcher to the Git runtime executable', () => {
    const root = createInstallRoot();
    const launcher = createExecutable(root, ['cmd', 'git.exe']);
    const executable = createExecutable(root, ['mingw64', 'bin', 'git.exe']);

    expect(resolveAutomaticWindowsGitExecutable(launcher)).toBe(executable);
  });

  it('resolves the bin launcher to the Git runtime executable', () => {
    const root = createInstallRoot();
    const launcher = createExecutable(root, ['bin', 'git.exe']);
    const executable = createExecutable(root, ['mingw64', 'bin', 'git.exe']);

    expect(resolveAutomaticWindowsGitExecutable(launcher)).toBe(executable);
  });

  it('keeps a launcher when the installation has no recognized runtime executable', () => {
    const root = createInstallRoot();
    const launcher = createExecutable(root, ['cmd', 'git.exe']);

    expect(resolveAutomaticWindowsGitExecutable(launcher)).toBe(launcher);
  });

  it('keeps an executable outside a Git launcher directory', () => {
    const root = createInstallRoot();
    const executable = createExecutable(root, ['custom', 'git.exe']);

    expect(resolveAutomaticWindowsGitExecutable(executable)).toBe(executable);
  });
});

describe('normalizeGitExecutableCandidate', () => {
  it('prefers an adjacent exe for an explicitly configured command shim', () => {
    const root = createInstallRoot();
    const command = createExecutable(root, ['git.cmd']);
    const executable = createExecutable(root, ['git.exe']);

    expect(normalizeGitExecutableCandidate(command)).toBe(executable);
  });
});

describe('createGitBinaryResolver', () => {
  it('resolves a PATH launcher to the runtime executable once', () => {
    const root = createInstallRoot();
    createExecutable(root, ['cmd', 'git.exe']);
    const executable = createExecutable(root, ['mingw64', 'bin', 'git.exe']);
    const resolveGitBinary = createGitBinaryResolver({
      environment: { PATH: path.join(root, 'cmd') },
      platform: 'win32',
      architecture: 'x64',
    });

    expect(resolveGitBinary()).toBe(executable);
    fs.rmSync(executable);
    expect(resolveGitBinary()).toBe(executable);
  });

  it('honors an explicit executable without remapping it as an automatic launcher', () => {
    const root = createInstallRoot();
    const launcher = createExecutable(root, ['cmd', 'git.exe']);
    createExecutable(root, ['mingw64', 'bin', 'git.exe']);
    const resolveGitBinary = createGitBinaryResolver({
      environment: { GIT_BINARY: launcher },
      platform: 'win32',
      architecture: 'x64',
    });

    expect(resolveGitBinary()).toBe(launcher);
  });
});
