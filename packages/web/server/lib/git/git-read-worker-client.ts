import { SHARE_ENV, Worker } from 'node:worker_threads';
import { failureCode, type GitReadInputs, type ReadFailure, type ReadOperation, type ReadResult, type WorkerOutput } from './git-read-protocol.js';

type ReadOptions = { signal?: AbortSignal | undefined };
type Lane = { worker: Worker | null; activeRequest: Pending | null; circuitOpen: boolean };
interface Pending {
  requestId: string; operation: ReadOperation; payload: GitReadInputs[ReadOperation]; signal: AbortSignal | undefined;
  cancellationBuffer: SharedArrayBuffer; cancellationView: Int32Array; lane: Lane | null; settled: boolean; onAbort: (() => void) | null;
  resolve(value: unknown): void; reject(error: unknown): void;
}

export const GIT_READ_WORKER_UNAVAILABLE_CODE = 'GIT_READ_WORKER_UNAVAILABLE';
const GIT_READ_WORKER_POOL_SIZE = 4;

const createUnavailableError = () => Object.assign(
  new Error('Git read worker is recovering from a timed-out process launch'),
  { code: GIT_READ_WORKER_UNAVAILABLE_CODE },
);

const createAbortError = (signal?: AbortSignal): Error => signal?.reason instanceof Error
  ? signal.reason
  : Object.assign(new Error('Git read cancelled'), { code: 'ABORT_ERR' });

const createWorkerError = (payload: ReadFailure) => Object.assign(new Error(payload.message || 'Git read worker failed'), { code: payload.code });

const defaultCreateWorker = () => new Worker(
  new URL(import.meta.url.endsWith('.ts') ? './git-read-worker.ts' : './git-read-worker.js', import.meta.url),
  import.meta.url.endsWith('.ts') && !process.versions.bun
    ? { env: SHARE_ENV, execArgv: [...process.execArgv, '--import', new URL('../../../scripts/register-server-sources.mjs', import.meta.url).href] }
    : { env: SHARE_ENV },
);

export class GitReadWorkerClient {
  readonly createWorker: () => Worker;
  readonly lanes: Lane[];
  readonly queuedRequests: Pending[];
  nextRequestId: number;
  isPumping: boolean;
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

  run<K extends ReadOperation>(operation: K, payload: GitReadInputs[K], options?: ReadOptions): Promise<ReadResult<K>>;
  run(operation: ReadOperation, payload: GitReadInputs[ReadOperation], { signal }: ReadOptions = {}): Promise<unknown> {
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
      const request: Pending = {
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

  ensureWorker(lane: Lane) {
    if (lane.worker) {
      return lane.worker;
    }

    const worker = this.createWorker();
    lane.worker = worker;
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
          const worker = this.ensureWorker(lane);
          worker.ref?.();
          worker.postMessage({
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

  abortRequest(request: Pending) {
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
          reason: { message: error.message, code: failureCode(error) },
        });
      } catch {
        // The worker failure/exit handler owns cleanup when IPC is already gone.
      }
      this.settleRequest(request, error);
      lane.worker?.unref?.();
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

  handleMessage(lane: Lane, worker: Worker, message: WorkerOutput) {
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
    worker.unref?.();
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

  handleWorkerFailure(lane: Lane, worker: Worker, error: unknown) {
    if (!worker || lane.worker !== worker) {
      return;
    }

    worker.unref?.();
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

  rejectQueuedRequests(error: Error) {
    for (const request of this.queuedRequests.splice(0)) {
      if (!request.settled) {
        this.settleRequest(request, error);
      }
    }
  }

  settleRequest(request: Pending, error: unknown, result?: unknown) {
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

  detachAbortListener(request: Pending) {
    if (request.onAbort) {
      request.signal?.removeEventListener('abort', request.onAbort);
      request.onAbort = null;
    }
  }
}

const gitReadWorkerClient = new GitReadWorkerClient();

export const runGitReadWorkerTask = <K extends ReadOperation>(operation: K, payload: GitReadInputs[K], options?: ReadOptions) => (
  gitReadWorkerClient.run(operation, payload, options)
);
