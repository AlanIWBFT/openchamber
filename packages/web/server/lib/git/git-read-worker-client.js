import { SHARE_ENV, Worker } from 'node:worker_threads';

export const GIT_READ_WORKER_UNAVAILABLE_CODE = 'GIT_READ_WORKER_UNAVAILABLE';
const GIT_READ_WORKER_POOL_SIZE = 4;

const createUnavailableError = () => Object.assign(
  new Error('Git read worker is recovering from a timed-out process launch'),
  { code: GIT_READ_WORKER_UNAVAILABLE_CODE },
);

const createAbortError = (signal) => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Git read cancelled'), { code: 'ABORT_ERR' });

const createWorkerError = (payload) => {
  const error = new Error(String(payload?.message || 'Git read worker failed'));
  if (payload?.code) {
    error.code = String(payload.code);
  }
  return error;
};

const defaultCreateWorker = () => new Worker(
  new URL('./git-read-worker.js', import.meta.url),
  { env: SHARE_ENV },
);

export class GitReadWorkerClient {
  constructor({ createWorker = defaultCreateWorker, poolSize = GIT_READ_WORKER_POOL_SIZE } = {}) {
    if (!Number.isInteger(poolSize) || poolSize < 1) {
      throw new RangeError('Git read worker pool size must be a positive integer');
    }
    this.createWorker = createWorker;
    this.lanes = Array.from({ length: poolSize }, () => ({
      worker: null,
      activeRequest: null,
      circuitOpen: false,
    }));
    this.queuedRequests = [];
    this.nextRequestId = 1;
    this.isPumping = false;
  }

  run(operation, payload, { signal } = {}) {
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal));
    }
    if (this.lanes.every((lane) => lane.circuitOpen)) {
      return Promise.reject(createUnavailableError());
    }

    const requestId = String(this.nextRequestId++);
    const cancellationBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const cancellationView = new Int32Array(cancellationBuffer);

    return new Promise((resolve, reject) => {
      const request = {
        requestId,
        operation,
        payload,
        signal,
        cancellationBuffer,
        cancellationView,
        resolve,
        reject,
        lane: null,
        settled: false,
        onAbort: null,
      };
      request.onAbort = () => this.abortRequest(request);
      signal?.addEventListener('abort', request.onAbort, { once: true });
      this.queuedRequests.push(request);
      this.pump();
    });
  }

  ensureWorker(lane) {
    if (lane.worker) {
      return lane.worker;
    }

    const worker = this.createWorker();
    lane.worker = worker;
    worker.unref?.();
    worker.on('message', (message) => this.handleMessage(lane, worker, message));
    worker.on('error', (error) => this.handleWorkerFailure(lane, worker, error));
    worker.on('exit', (code) => {
      if (code !== 0) {
        this.handleWorkerFailure(lane, worker, new Error(`Git read worker exited with code ${code}`));
      } else if (lane.worker === worker) {
        this.handleWorkerFailure(lane, worker, new Error('Git read worker exited unexpectedly'));
      }
    });
    return worker;
  }

  pump() {
    if (this.isPumping) {
      return;
    }

    this.isPumping = true;
    try {
      for (const lane of this.lanes) {
        if (lane.activeRequest || lane.circuitOpen) {
          continue;
        }

        let request = this.queuedRequests.shift();
        while (request?.settled) {
          request = this.queuedRequests.shift();
        }
        if (!request) {
          break;
        }

        lane.activeRequest = request;
        request.lane = lane;
        try {
          this.ensureWorker(lane).postMessage({
            type: 'request',
            requestId: request.requestId,
            operation: request.operation,
            payload: request.payload,
            cancellationBuffer: request.cancellationBuffer,
          });
        } catch (error) {
          if (lane.worker) {
            this.handleWorkerFailure(lane, lane.worker, error);
            continue;
          }
          lane.activeRequest = null;
          request.lane = null;
          this.settleRequest(request, error);
        }
      }
    } finally {
      this.isPumping = false;
    }
    if (this.queuedRequests.length > 0 && this.lanes.some((lane) => !lane.activeRequest && !lane.circuitOpen)) {
      queueMicrotask(() => this.pump());
    }
  }

  abortRequest(request) {
    if (request.settled) {
      return;
    }

    Atomics.store(request.cancellationView, 0, 1);
    const error = createAbortError(request.signal);
    const lane = request.lane;
    if (lane?.activeRequest === request) {
      lane.circuitOpen = true;
      try {
        lane.worker?.postMessage({
          type: 'cancel',
          requestId: request.requestId,
          reason: { message: error.message, code: error.code },
        });
      } catch {
        // The worker failure/exit handler owns cleanup when IPC is already gone.
      }
      this.settleRequest(request, error);
      if (this.lanes.every((candidate) => candidate.circuitOpen)) {
        this.rejectQueuedRequests(createUnavailableError());
      } else {
        this.pump();
      }
      return;
    }

    const queuedIndex = this.queuedRequests.indexOf(request);
    if (queuedIndex !== -1) {
      this.queuedRequests.splice(queuedIndex, 1);
    }
    this.settleRequest(request, error);
  }

  handleMessage(lane, worker, message) {
    if (lane.worker !== worker || message?.type !== 'response') {
      return;
    }

    const request = lane.activeRequest;
    if (!request || message.requestId !== request.requestId) {
      return;
    }

    lane.activeRequest = null;
    lane.circuitOpen = false;
    request.lane = null;
    if (!request.settled) {
      if (message.ok) {
        this.settleRequest(request, null, message.result);
      } else {
        this.settleRequest(request, createWorkerError(message.error));
      }
    } else {
      this.detachAbortListener(request);
    }
    this.pump();
  }

  handleWorkerFailure(lane, worker, error) {
    if (!worker || lane.worker !== worker) {
      return;
    }

    lane.worker = null;
    lane.circuitOpen = false;
    const activeRequest = lane.activeRequest;
    lane.activeRequest = null;
    if (activeRequest) {
      activeRequest.lane = null;
    }
    if (activeRequest && !activeRequest.settled) {
      this.settleRequest(activeRequest, error);
    }
    this.pump();
  }

  rejectQueuedRequests(error) {
    for (const request of this.queuedRequests.splice(0)) {
      if (!request.settled) {
        this.settleRequest(request, error);
      }
    }
  }

  settleRequest(request, error, result) {
    if (request.settled) {
      return;
    }
    request.settled = true;
    this.detachAbortListener(request);
    if (error) {
      request.reject(error);
    } else {
      request.resolve(result);
    }
  }

  detachAbortListener(request) {
    if (request.onAbort) {
      request.signal?.removeEventListener('abort', request.onAbort);
      request.onAbort = null;
    }
  }
}

const gitReadWorkerClient = new GitReadWorkerClient();

export const runGitReadWorkerTask = (operation, payload, options) => (
  gitReadWorkerClient.run(operation, payload, options)
);
