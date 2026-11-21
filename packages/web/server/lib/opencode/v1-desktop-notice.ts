import { Worker } from 'node:worker_threads';

export type LegacySessionAdvice = 'standalone' | 'backup';

export function readLegacySessionAdvice(dbPath: string): Promise<LegacySessionAdvice | null> {
  if (dbPath === ':memory:') return Promise.resolve(null);
  const url = new URL(import.meta.url.endsWith('.ts') ? './v1-desktop-inspector.ts' : './v1-desktop-inspector.js', import.meta.url);
  return new Promise((resolve) => {
    const worker = new Worker(url, { workerData: dbPath });
    worker.once('message', (value) => resolve(value === 'backup' || value === 'standalone' ? value : null));
    worker.once('error', () => resolve(null));
    worker.once('exit', () => resolve(null));
  });
}
