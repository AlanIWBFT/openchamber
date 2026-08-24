import { parentPort, workerData } from 'node:worker_threads';
import { probeWindowsShellEnvSnapshot } from './env-runtime.js';

if (!parentPort) {
  throw new Error('Windows shell environment worker requires a parent port');
}

parentPort.postMessage(probeWindowsShellEnvSnapshot({ env: workerData?.env }));
