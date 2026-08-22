const activeTasks = new Map();

const createAbortError = (signal) => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Git read cancelled'), { code: 'ABORT_ERR' });

const createTask = (key, taskFactory) => {
  const controller = new AbortController();
  const entry = {
    controller,
    promise: null,
    settled: false,
    waiters: 0,
  };
  entry.promise = Promise.resolve()
    .then(() => taskFactory(controller.signal))
    .finally(() => {
      entry.settled = true;
      if (activeTasks.get(key) === entry) {
        activeTasks.delete(key);
      }
    });
  activeTasks.set(key, entry);
  return entry;
};

const waitForTask = (entry, signal) => new Promise((resolve, reject) => {
  let released = false;
  entry.waiters += 1;

  const release = (aborted) => {
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

export const runSharedGitReadTask = (key, taskFactory, { signal } = {}) => {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(signal));
  }
  const activeTask = activeTasks.get(key);
  const entry = activeTask && !activeTask.controller.signal.aborted
    ? activeTask
    : createTask(key, taskFactory);
  return waitForTask(entry, signal);
};
