import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const infoSchema = z.object({ distribution: z.literal('openchamber'), version: z.string().min(1) });
export const forkRequired = 'Select a CLI built from the OpenChamber fork of OpenCode, or use the bundled service.';

export class UnsupportedOpenCodeDistributionError extends Error {
  readonly code = 'OPENCODE_BINARY_INVALID';
  constructor() { super(forkRequired); }
}

const requireForkIdentity = (info: ReturnType<typeof infoSchema.safeParse>) => {
  if (!info.success) throw new UnsupportedOpenCodeDistributionError();
  return info.data;
};

export interface OpenCodeCompatibility {
  state: 'unavailable' | 'compatible' | 'incompatible';
  version: string | null;
  installation: 'managed' | 'external' | 'bundled';
  binary: string | null;
}

export interface OpenCodeCliLaunch {
  binary: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

export interface OpenCodeCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export const readOpenCodeInfo = async (response: Response) => {
  if (!response.ok) return null;
  const body: unknown = await response.json().catch(() => null);
  return requireForkIdentity(infoSchema.safeParse(body));
};

export const readOpenCodeCliVersion = async (launch: OpenCodeCliLaunch, options: OpenCodeCliOptions = {}) => {
  const { stdout } = await execute(launch.binary, [...launch.args, '--openchamber-info'], {
    ...options,
    env: { ...(options.env ?? process.env), ...launch.env },
    encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true,
  }).catch(error => {
    if (!z.object({ code: z.number() }).safeParse(error).success) throw error;
    throw new UnsupportedOpenCodeDistributionError();
  });
  return parseCliIdentity(stdout).version;
};

export const parseCliIdentity = (output: string) => {
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new UnsupportedOpenCodeDistributionError(); }
  return requireForkIdentity(infoSchema.safeParse(value));
};

export const readExternalOpenCodeVersion = async (baseUrl: string, headers: Record<string, string>, fetchImpl = fetch) => {
  const response = await fetchImpl(new URL('/api/info', baseUrl), {
    headers: { ...headers, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  return response ? (await readOpenCodeInfo(response))?.version ?? null : null;
};

export const checkOpenCodeCompatibility = async (read: () => Promise<string | null>, installation: OpenCodeCompatibility['installation'], binary: string | null = null): Promise<OpenCodeCompatibility> => {
  try {
    const version = await read();
    return { state: version === null ? 'unavailable' : 'compatible', version, installation, binary };
  } catch (error) {
    return { state: error instanceof UnsupportedOpenCodeDistributionError ? 'incompatible' : 'unavailable', version: null, installation, binary };
  }
};
