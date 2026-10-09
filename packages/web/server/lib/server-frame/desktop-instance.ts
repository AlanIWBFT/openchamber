import fs from 'node:fs';
import path from 'node:path';

const recordFile = (dataDir: string) => path.join(dataDir, 'run', 'desktop-instance.json');

export function readDesktopInstance(dataDir: string): { port: number; pid: number } | null {
  try {
    const { port, pid } = JSON.parse(fs.readFileSync(recordFile(dataDir), 'utf8'));
    return Number.isInteger(port) && port > 0 && port <= 65535 && Number.isInteger(pid) && pid > 0 ? { port, pid } : null;
  } catch {
    return null;
  }
}

export function publishDesktopInstance(dataDir: string, port: number) {
  const file = recordFile(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temp, JSON.stringify({ port, pid: process.pid }), { mode: 0o600 });
  fs.renameSync(temp, file);
  return () => {
    const current = readDesktopInstance(dataDir);
    if (current?.pid === process.pid && current.port === port) fs.rmSync(file, { force: true });
  };
}
