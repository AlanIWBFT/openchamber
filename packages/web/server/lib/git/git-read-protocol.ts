import type { GitReadResults } from './service.js';

interface ReadPayloads {
  status: { directory: string; mode?: string | undefined };
  'pr-context': { directory: string; branch: string };
  ancestor: { directory: string; sha: string };
  'patch-equivalent': { directory: string; sha: string };
  'file-diff': { directory: string; path?: string | undefined; staged?: boolean | undefined; previousPath?: string | undefined };
  'renameable-branch': { directory: string; checkedOutBranch: string | null };
}
export type ReadOperation = keyof ReadPayloads;
export type ReadEnvironment = Record<string, string> | null;
export type GitReadInputs = { [K in ReadOperation]: ReadPayloads[K] & { environment?: ReadEnvironment } };
export type ReadResult<K extends ReadOperation> = GitReadResults[K];
export type ReadFailure = { message: string; code?: string | undefined };
export type WorkerRequest = {
  [K in ReadOperation]: { type: 'request'; requestId: string; operation: K; payload: GitReadInputs[K]; cancellationBuffer: SharedArrayBuffer }
}[ReadOperation];
export type WorkerInput = WorkerRequest | { type: 'cancel'; requestId: string; reason: ReadFailure };
export type WorkerOutput = { type: 'response'; requestId: string } & ({ ok: true; result: unknown } | { ok: false; error: ReadFailure });
export function failureCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
