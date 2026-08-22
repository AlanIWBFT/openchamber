import { createSharedGitReads } from './git-read-shared.js';
import type { GitReadResults } from './service.js';

const GIT_STATUS_TASK_TIMEOUT_MS = 30_000;
export const GIT_STATUS_TIMEOUT_CODE = 'GIT_STATUS_TIMEOUT';

const readStatus = createSharedGitReads<GitReadResults['status']>();
const statusTaskKey = (directory: string, mode?: string) => {
  const directoryValue = String(directory || '').trim();
  const directoryKey = process.platform === 'win32'
    ? directoryValue.replace(/\\/g, '/').toLowerCase()
    : directoryValue;
  return `${directoryKey}\0${mode || ''}`;
};

type StatusRead = (signal: AbortSignal) => Promise<GitReadResults['status']>;
const createTimedStatusTask = (taskFactory: StatusRead, sharedSignal: AbortSignal) => {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const signal = AbortSignal.any([controller.signal, sharedSignal]);
  const statusTask = Promise.resolve().then(() => { signal.throwIfAborted(); return taskFactory(signal); });
  const timeoutTask = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = Object.assign(
        new Error(`Git status timed out after ${GIT_STATUS_TASK_TIMEOUT_MS}ms`),
        { code: GIT_STATUS_TIMEOUT_CODE },
      );
      controller.abort(timeoutError);
      reject(timeoutError);
    }, GIT_STATUS_TASK_TIMEOUT_MS);
  });

  return Promise.race([statusTask, timeoutTask]).finally(() => clearTimeout(timeoutId));
};

export function runGitStatusTask(directory: string, { mode, authoritative = false, signal }: { mode?: string | undefined; authoritative?: boolean; signal?: AbortSignal | undefined }, taskFactory: StatusRead) {
  return readStatus(statusTaskKey(directory, mode), shared => createTimedStatusTask(taskFactory, shared), { signal, replace: authoritative });
}
