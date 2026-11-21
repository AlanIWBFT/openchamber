import { isString } from '../shared/object-guards.js';
import type { GitReadResults } from './service.js';

interface ReadPayloads {
  status: { directory: string; mode?: string | undefined };
  'pr-context': { directory: string; branch: string };
  'branch-tip': { directory: string; branch: string };
  'branch-change-ids': { directory: string; branch: string; base: string | null };
  'gerrit-upstream': { directory: string; branch: string; remote: string };
  ancestor: { directory: string; sha: string };
  'patch-equivalent': { directory: string; sha: string };
  'file-diff': { directory: string; path?: string | undefined; staged?: boolean | undefined; previousPath?: string | undefined };
  'renameable-branch': { directory: string; checkedOutBranch: string | null };
}
export type ReadOperation = keyof ReadPayloads;
export type ReadEnvironment = Record<string, string> | null;
export type GitReadInputs = { [K in ReadOperation]: ReadPayloads[K] & { environment?: ReadEnvironment } };
export type ReadResult<K extends ReadOperation> = GitReadResults[K];
export type ReadFailure = { message: string; code?: string | undefined; status?: number | undefined };
export type WorkerRequest = {
  [K in ReadOperation]: { type: 'request'; requestId: string; operation: K; payload: GitReadInputs[K]; cancellationBuffer: SharedArrayBuffer }
}[ReadOperation];
export type WorkerInput = WorkerRequest | { type: 'cancel'; requestId: string; reason: ReadFailure };
export type WorkerOutput = { type: 'response'; requestId: string } & ({ ok: true; result: ReadResult<ReadOperation> } | { ok: false; error: ReadFailure });
export function failureCode(error: Error): string | undefined {
  return 'code' in error && isString(error.code) ? error.code : undefined;
}
