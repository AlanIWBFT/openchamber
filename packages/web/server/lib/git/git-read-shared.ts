import type { GitReadResults } from './service.js';

type Factory<T> = (signal: AbortSignal) => Promise<T>;
type Entry<T> = { controller: AbortController; promise: Promise<T>; settled: boolean; waiters: number };

const createAbortError = (signal?: AbortSignal) => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Git read cancelled'), { code: 'ABORT_ERR' });

const createTask = <T>(activeTasks: Map<string, Entry<T>>, key: string, taskFactory: Factory<T>) => {
  const controller = new AbortController();
  const entry: Entry<T> = {
    controller,
    promise: Promise.resolve().then(() => taskFactory(controller.signal)),
    settled: false,
    waiters: 0,
  };
  entry.promise = entry.promise.finally(() => {
      entry.settled = true;
      if (activeTasks.get(key) === entry) {
        activeTasks.delete(key);
      }
    });
  activeTasks.set(key, entry);
  return entry;
};

const waitForTask = <T>(entry: Entry<T>, signal?: AbortSignal) => new Promise<T>((resolve, reject) => {
  let released = false;
  entry.waiters += 1;

  const release = (aborted: boolean) => {
    if (released) {
      return;
    }
    released = true;
    signal?.removeEventListener('abort', onAbort);
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (aborted && entry.waiters === 0 && !entry.settled && !entry.controller.signal.aborted) {
      entry.controller.abort(createAbortError(signal));
    }
  };

  const onAbort = () => {
    release(true);
    reject(createAbortError(signal));
  };

  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  entry.promise.then(
    (result) => {
      release(false);
      resolve(result);
    },
    (error) => {
      release(false);
      reject(error);
    },
  );
});

export function createSharedGitReads<T>() {
  const activeTasks = new Map<string, Entry<T>>();
  return (key: string, taskFactory: Factory<T>, { signal, replace = false }: { signal?: AbortSignal | undefined; replace?: boolean } = {}) => {
    if (signal?.aborted) return Promise.reject(createAbortError(signal));
    const activeTask = activeTasks.get(key);
    const entry = !replace && activeTask && !activeTask.controller.signal.aborted ? activeTask : createTask(activeTasks, key, taskFactory);
    return waitForTask(entry, signal);
  };
}
export const runSharedGitReadTask = createSharedGitReads<GitReadResults['pr-context']>();
