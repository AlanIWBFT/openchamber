import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const info = z.object({ version: z.string().min(1) });

export async function readInstalledOpenCodeVersion(): Promise<string | null> {
  try {
    const response = await runtimeFetch('/api/opencode/version');
    if (!response.ok) return null;
    return info.parse(await response.json()).version;
  } catch { return null; }
}
