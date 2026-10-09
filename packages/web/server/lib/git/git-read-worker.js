import { parentPort } from 'node:worker_threads';

import { getFileDiff, getPrGitContext, getStatus, isAncestorOfHead, withGitReadEnvironment } from './service.js';

if (!parentPort) {
  throw new Error('Git read worker requires a parent port');
}

let activeRequest = null;

const createCancellationError = (reason) => Object.assign(
  new Error(String(reason?.message || 'Git read cancelled')),
  { code: reason?.code ? String(reason.code) : 'ABORT_ERR' },
);

const serializeError = (error) => ({
  message: error instanceof Error ? error.message : String(error || 'Git read worker failed'),
  code: error?.code ? String(error.code) : undefined,
});

const runRequest = async (message) => {
  const cancellationView = new Int32Array(message.cancellationBuffer);
  const controller = new AbortController();
  const request = {
    requestId: message.requestId,
    cancellationView,
    controller,
  };
  activeRequest = request;

  try {
    if (Atomics.load(cancellationView, 0) !== 0) {
      throw createCancellationError();
    }

    const result = await withGitReadEnvironment(message.payload.environment, async () => {
      const options = { signal: controller.signal, cancellationView };
      if (message.operation === 'status') {
        return getStatus(message.payload.directory, { ...options, mode: message.payload.mode });
      }
      if (message.operation === 'pr-context') {
        return getPrGitContext(message.payload.directory, message.payload.branch, options);
      }
      if (message.operation === 'ancestor') {
        return isAncestorOfHead(message.payload.directory, message.payload.sha, options);
      }
      if (message.operation === 'file-diff') {
        return getFileDiff(message.payload.directory, { ...options, path: message.payload.path, staged: message.payload.staged });
      }
      throw new Error(`Unsupported Git read operation: ${message.operation}`);
    });
    parentPort.postMessage({ type: 'response', requestId: message.requestId, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: serializeError(error),
    });
  } finally {
    if (activeRequest === request) {
      activeRequest = null;
    }
  }
};

parentPort.on('message', (message) => {
  if (message?.type === 'cancel') {
    if (activeRequest?.requestId === message.requestId) {
      Atomics.store(activeRequest.cancellationView, 0, 1);
      activeRequest.controller.abort(createCancellationError(message.reason));
    }
    return;
  }

  if (message?.type !== 'request') {
    return;
  }
  if (activeRequest) {
    parentPort.postMessage({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: { message: 'Git read worker received a concurrent request', code: 'GIT_READ_WORKER_PROTOCOL' },
    });
    return;
  }
  void runRequest(message);
});
