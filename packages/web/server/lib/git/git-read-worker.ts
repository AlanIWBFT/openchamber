import { parentPort } from 'node:worker_threads';
import { failureCode, type ReadFailure, type WorkerInput, type WorkerRequest } from './git-read-protocol.js';

import { getFileDiff, getPrGitContext, getStatus, isAncestorOfHead, isPatchEquivalentOfHead, readRenameableGeneratedBranch } from './service.js';

if (!parentPort) {
  throw new Error('Git read worker requires a parent port');
}

let activeRequest: { requestId: string; cancellationView: Int32Array; controller: AbortController } | null = null;

const createCancellationError = (reason?: ReadFailure) => Object.assign(
  new Error(String(reason?.message || 'Git read cancelled')),
  { code: reason?.code ? String(reason.code) : 'ABORT_ERR' },
);

const serializeError = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error || 'Git read worker failed'),
  code: failureCode(error),
});

const port = parentPort;
const runRequest = async (message: WorkerRequest) => {
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

    let result;
    if (message.operation === 'status') {
      result = await getStatus(message.payload.directory, {
        mode: message.payload.mode,
        signal: controller.signal,
        cancellationView,
      });
    } else if (message.operation === 'pr-context') {
      result = await getPrGitContext(message.payload.directory, message.payload.branch, {
        signal: controller.signal,
        cancellationView,
      });
    } else if (message.operation === 'ancestor') {
      result = await isAncestorOfHead(message.payload.directory, message.payload.sha, {
        signal: controller.signal,
        cancellationView,
      });
    } else if (message.operation === 'patch-equivalent') {
      result = await isPatchEquivalentOfHead(message.payload.directory, message.payload.sha, {
        signal: controller.signal,
        cancellationView,
      });
    } else if (message.operation === 'file-diff') {
      result = await getFileDiff(message.payload.directory, {
        path: message.payload.path,
        staged: message.payload.staged,
        previousPath: message.payload.previousPath,
        signal: controller.signal,
        cancellationView,
      });
    } else if (message.operation === 'renameable-branch') {
      result = await readRenameableGeneratedBranch(message.payload.directory, message.payload.checkedOutBranch, {
        signal: controller.signal,
        cancellationView,
      });
    } else {
      throw new Error('Unsupported Git read operation');
    }

    port.postMessage({ type: 'response', requestId: message.requestId, ok: true, result });
  } catch (error) {
    port.postMessage({
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

port.on('message', (message: WorkerInput) => {
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
    port.postMessage({
      type: 'response',
      requestId: message.requestId,
      ok: false,
      error: { message: 'Git read worker received a concurrent request', code: 'GIT_READ_WORKER_PROTOCOL' },
    });
    return;
  }
  void runRequest(message);
});
