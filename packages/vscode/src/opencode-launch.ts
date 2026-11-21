import path from 'node:path';

export function resolveWindowsLaunchSpec(binary: string, args: string[]): { binary: string; args: string[] } {
  if (process.platform !== 'win32') return { binary, args };
  const trimmed = binary.trim();
  const ext = path.extname(trimmed).toLowerCase();
  const batch = ext === '.cmd' || ext === '.bat';
  const bare = !ext && !trimmed.includes('\\') && !trimmed.includes('/');
  return batch || bare
    ? { binary: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', 'call', trimmed, ...args] }
    : { binary: trimmed, args };
}
