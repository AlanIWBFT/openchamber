import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execute = promisify(execFile);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
const infoSchema = z.object({ distribution: z.literal('openchamber'), version: versionSchema });
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
  minimumVersion: string;
  canInstall: boolean;
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

const MINIMUM_OPENCODE_VERSION = '2.2.4';

const releaseParts = (version: string) => (version.split(/[-+]/, 1)[0] ?? '').split('.').map(Number);

const compareRelease = (left: string, right: string) => {
  const a = releaseParts(left);
  const b = releaseParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return (a[index] ?? NaN) - (b[index] ?? NaN);
  }
  return 0;
};

export const isOpenCodeOlderThan = (version: string, minimum: string) => versionSchema.safeParse(version).success
  && compareRelease(version, minimum) < 0;

const isOlderThanMinimum = (version: string) => isOpenCodeOlderThan(version, MINIMUM_OPENCODE_VERSION);

export const isSupportedOpenCodeVersion = (version: string) => versionSchema.safeParse(version).success
  && releaseParts(version)[0] === 2
  && !isOlderThanMinimum(version);

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

export class UnsupportedOpenCodeVersionError extends Error {
  version: string;

  constructor(version: string) {
    super(`OpenCode ${version} is installed. OpenChamber requires OpenCode ${MINIMUM_OPENCODE_VERSION} or newer.`);
    this.name = 'UnsupportedOpenCodeVersionError';
    this.version = version;
  }
}

export const requireOpenCodeV2 = async (launch: OpenCodeCliLaunch, options?: OpenCodeCliOptions) => {
  const version = await readOpenCodeCliVersion(launch, options);
  if (!isSupportedOpenCodeVersion(version)) throw new UnsupportedOpenCodeVersionError(version);
  return version;
};

export const readExternalOpenCodeVersion = async (baseUrl: string, headers: Record<string, string>, fetchImpl = fetch) => {
  const response = await fetchImpl(new URL('/api/info', baseUrl), {
    headers: { ...headers, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(5000),
  }).catch(() => null);
  return response ? (await readOpenCodeInfo(response))?.version ?? null : null;
};

export const describeOpenCodeCompatibility = (version: string | null, installation: OpenCodeCompatibility['installation'], binary: string | null = null): OpenCodeCompatibility => ({
  state: version === null ? 'unavailable' : isSupportedOpenCodeVersion(version) ? 'compatible' : 'incompatible',
  version,
  installation,
  binary,
  minimumVersion: MINIMUM_OPENCODE_VERSION,
  canInstall: false,
});

export const checkOpenCodeCompatibility = async (read: () => Promise<string | null>, installation: OpenCodeCompatibility['installation'], binary: string | null = null): Promise<OpenCodeCompatibility> => {
  try { return describeOpenCodeCompatibility(await read(), installation, binary); }
  catch (error) {
    const status = describeOpenCodeCompatibility(null, installation, binary);
    return error instanceof UnsupportedOpenCodeDistributionError ? { ...status, state: 'incompatible' } : status;
  }
};
