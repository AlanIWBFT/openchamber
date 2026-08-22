const GIT_STATUS_TASK_TIMEOUT_MS = 30_000;
export const GIT_STATUS_TIMEOUT_CODE = 'GIT_STATUS_TIMEOUT';

const activeStatusTasks = new Map();

const statusTaskKey = (directory, mode) => {
  const directoryValue = String(directory || '').trim();
  const directoryKey = process.platform === 'win32'
    ? directoryValue.replace(/\\/g, '/').toLowerCase()
    : directoryValue;
  return `${directoryKey}\0${mode || ''}`;
};

const createTimedStatusTask = (taskFactory) => {
  const controller = new AbortController();
  let timeoutId;
  const statusTask = Promise.resolve().then(() => taskFactory(controller.signal));
  const timeoutTask = new Promise((_, reject) => {
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

export function runGitStatusTask(directory, { mode, authoritative = false } = {}, taskFactory) {
  const key = statusTaskKey(directory, mode);
  const activeTask = activeStatusTasks.get(key);
  if (!authoritative && activeTask) {
    return activeTask;
  }

  const task = createTimedStatusTask(taskFactory);
  activeStatusTasks.set(key, task);
  const clearTask = () => {
    if (activeStatusTasks.get(key) === task) {
      activeStatusTasks.delete(key);
    }
  };
  void task.then(clearTask, clearTask);
  return task;
}
