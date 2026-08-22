import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  GIT_READ_WORKER_UNAVAILABLE_CODE,
  GitReadWorkerClient,
} from './git-read-worker-client.js';

const GIT_READ_WORKER_POOL_SIZE = 4;

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.messages = [];
    this.unref = vi.fn();
  }

  postMessage(message) {
    this.messages.push(message);
  }

  respond(requestId, result = null) {
    this.emit('message', { type: 'response', requestId, ok: true, result });
  }
}

const requestMessages = (worker) => worker.messages.filter((message) => message.type === 'request');
const canRunGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('GitReadWorkerClient', () => {
  it('loads all real worker entries without launching Git', async () => {
    const client = new GitReadWorkerClient();

    const results = await Promise.allSettled(Array.from(
      { length: GIT_READ_WORKER_POOL_SIZE },
      () => client.run('unsupported', {}),
    ));
    expect(results).toHaveLength(GIT_READ_WORKER_POOL_SIZE);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect(result.reason).toMatchObject({ message: 'Unsupported Git read operation: unsupported' });
    }
  });

  it.runIf(canRunGit())('runs a complete file diff in a real worker', async () => {
    const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-git-read-worker-'));
    try {
      const runGit = (args) => execFileSync('git', args, { cwd: repository, stdio: 'ignore' });
      runGit(['init', '-b', 'main']);
      runGit(['config', 'user.email', 'test@example.com']);
      runGit(['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repository, 'file.txt'), 'before\n');
      runGit(['add', 'file.txt']);
      runGit(['commit', '-m', 'Initial commit']);
      fs.writeFileSync(path.join(repository, 'file.txt'), 'after\n');

      const client = new GitReadWorkerClient({ poolSize: 1 });
      await expect(client.run('file-diff', { directory: repository, path: 'file.txt', staged: false })).resolves.toEqual({
        original: 'before\n',
        modified: 'after\n',
        path: 'file.txt',
        isBinary: false,
      });
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  it('runs four requests concurrently and keeps excess work queued', async () => {
    const workers = [];
    const createWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const client = new GitReadWorkerClient({ createWorker });

    const active = Array.from({ length: GIT_READ_WORKER_POOL_SIZE }, (_, index) => (
      client.run('status', { directory: `active-${index}` })
    ));
    const queued = client.run('status', { directory: 'queued' });

    expect(workers).toHaveLength(GIT_READ_WORKER_POOL_SIZE);
    expect(workers.flatMap(requestMessages).map((message) => message.requestId)).toEqual(['1', '2', '3', '4']);

    workers[1].respond('2', 'second-result');
    await expect(active[1]).resolves.toBe('second-result');
    expect(requestMessages(workers[1]).map((message) => message.requestId)).toEqual(['2', '5']);
    workers[1].respond('5', 'queued-result');
    await expect(queued).resolves.toBe('queued-result');

    workers[0].respond('1', 'first-result');
    for (let index = 2; index < GIT_READ_WORKER_POOL_SIZE; index += 1) {
      workers[index].respond(String(index + 1), `result-${index}`);
    }
    await expect(Promise.all([active[0], ...active.slice(2)])).resolves.toEqual([
      'first-result',
      ...Array.from({ length: GIT_READ_WORKER_POOL_SIZE - 2 }, (_, index) => `result-${index + 2}`),
    ]);
    expect(createWorker).toHaveBeenCalledTimes(GIT_READ_WORKER_POOL_SIZE);
  });

  it('continues queued work on a healthy lane while one timed-out lane recovers', async () => {
    const workers = [];
    const createWorker = vi.fn(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    });
    const client = new GitReadWorkerClient({ createWorker, poolSize: 2 });
    const controller = new AbortController();
    const timedOut = client.run('status', { directory: 'timed-out' }, { signal: controller.signal });
    const healthy = client.run('status', { directory: 'healthy' });
    const queued = client.run('status', { directory: 'queued' });
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });

    controller.abort(timeout);
    await expect(timedOut).rejects.toBe(timeout);
    expect(workers[0].messages.some((message) => message.type === 'cancel' && message.requestId === '1')).toBe(true);
    expect(workers.flatMap(requestMessages).map((message) => message.requestId)).toEqual(['1', '2']);

    workers[1].respond('2', 'healthy-result');
    await expect(healthy).resolves.toBe('healthy-result');
    expect(requestMessages(workers[1]).map((message) => message.requestId)).toEqual(['2', '3']);
    workers[1].respond('3', 'queued-result');
    await expect(queued).resolves.toBe('queued-result');

    const stillHealthy = client.run('status', { directory: 'still-healthy' });
    expect(requestMessages(workers[1]).map((message) => message.requestId)).toEqual(['2', '3', '4']);
    workers[1].respond('4', 'still-healthy-result');
    await expect(stillHealthy).resolves.toBe('still-healthy-result');

    workers[0].respond('1');
    const recovered = client.run('status', { directory: 'recovered' });
    expect(requestMessages(workers[0]).map((message) => message.requestId)).toEqual(['1', '5']);
    workers[0].respond('5', 'recovered-result');
    await expect(recovered).resolves.toBe('recovered-result');
    expect(createWorker).toHaveBeenCalledTimes(2);
  });

  it('rejects queued and new work only when every lane is timed out', async () => {
    const workers = [];
    const client = new GitReadWorkerClient({
      poolSize: 2,
      createWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = client.run('status', { directory: 'first' }, { signal: firstController.signal });
    const second = client.run('status', { directory: 'second' }, { signal: secondController.signal });
    const queued = client.run('status', { directory: 'queued' });

    firstController.abort(new Error('first timed out'));
    secondController.abort(new Error('second timed out'));
    await expect(first).rejects.toThrow('first timed out');
    await expect(second).rejects.toThrow('second timed out');
    await expect(queued).rejects.toMatchObject({ code: GIT_READ_WORKER_UNAVAILABLE_CODE });
    await expect(client.run('status', { directory: 'blocked' })).rejects.toMatchObject({
      code: GIT_READ_WORKER_UNAVAILABLE_CODE,
    });

    workers[0].respond('1');
    workers[1].respond('2');
    const recovered = client.run('status', { directory: 'recovered' });
    workers[0].respond('4', 'recovered-result');
    await expect(recovered).resolves.toBe('recovered-result');
  });

  it('removes a cancelled queued request without opening the active lane circuit', async () => {
    const worker = new FakeWorker();
    const client = new GitReadWorkerClient({ createWorker: () => worker, poolSize: 1 });
    const active = client.run('status', { directory: 'active' });
    const controller = new AbortController();
    const queued = client.run('status', { directory: 'queued' }, { signal: controller.signal });
    const reason = new Error('queued request cancelled');

    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    worker.respond('1', 'active-result');
    await expect(active).resolves.toBe('active-result');
    expect(requestMessages(worker).map((message) => message.requestId)).toEqual(['1']);

    const next = client.run('status', { directory: 'next' });
    worker.respond('3', 'next-result');
    await expect(next).resolves.toBe('next-result');
  });

  it('rejects a worker startup failure without leaving the request active', async () => {
    const failure = new Error('worker startup failed');
    const client = new GitReadWorkerClient({ createWorker: () => { throw failure; }, poolSize: 1 });

    await expect(client.run('status', { directory: 'first' })).rejects.toBe(failure);
    await expect(client.run('status', { directory: 'second' })).rejects.toBe(failure);
  });
});
