import fs from 'node:fs';

export const configuredBinaryError = (configured: string, normalized: string | null, isDesktopApp: (file: string) => boolean) => {
  const candidate = normalized?.trim() || configured;
  const bin = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  const app = process.platform === 'win32' ? 'Windows desktop app install' : 'macOS desktop app bundle';
  const describe = () => {
    if (isDesktopApp(candidate) || isDesktopApp(configured)) return `Configured OpenCode binary points at the ${app}, not the CLI: ${candidate}.`;
    const dir = [configured, candidate].find(file => fs.statSync(file, { throwIfNoEntry: false })?.isDirectory());
    if (dir) return `Configured OpenCode binary directory does not contain an executable ${bin}: ${dir}.`;
    const stat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (!stat) return `Configured OpenCode binary not found: ${candidate}.`;
    if (!stat.isFile()) return `Configured OpenCode binary is not a file: ${candidate}.`;
    return `Configured OpenCode binary is not executable: ${candidate}.`;
  };
  const error: NodeJS.ErrnoException = new Error(`${describe()} Select the standalone OpenChamber fork CLI.`);
  error.code = 'OPENCODE_BINARY_INVALID';
  return error;
};
