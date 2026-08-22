import { createServer } from 'node:http';
import express from 'express';
import { expect, test } from 'vitest';
import { registerGitStatusBatchRoute } from './status-batch.js';
import { runGitStatusTask } from './status-tasks.js';

test('disconnect releases only that batch’s share of a directory read', async () => {
  const started = Promise.withResolvers();
  const shared = Promise.withResolvers();
  const cancelled = Promise.withResolvers();
  const entered = [];
  const signals = new Map();
  const read = (directory, _mode, signal) => runGitStatusTask(directory, { signal }, async underlying => {
    signals.set(directory, underlying);
    entered.push(directory);
    if (entered.length === 2) started.resolve();
    if (directory === '/kept') return shared.promise;
    return new Promise((_resolve, reject) => underlying.addEventListener('abort', () => {
      cancelled.resolve();
      reject(underlying.reason);
    }, { once: true }));
  });
  const app = express();
  app.use(express.json());
  registerGitStatusBatchRoute(app, read);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  const result = { isGitRepository: true, status: {} };
  try {
    const other = read('/kept');
    await fetch(`http://127.0.0.1:${server.address().port}/api/git/status/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ directories: ['/kept', '/abandoned'] }),
    });
    await started.promise;
    controller.abort();
    await cancelled.promise;
    expect(signals.get('/kept').aborted).toBe(false);
    shared.resolve(result);
    expect(await other).toBe(result);
    expect(entered.sort()).toEqual(['/abandoned', '/kept']);
  } finally {
    controller.abort();
    shared.resolve(result);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('streams fast and failed directories while a slow directory is still running', async () => {
  const slow = Promise.withResolvers();
  const app = express();
  app.use(express.json());
  registerGitStatusBatchRoute(app, async (directory) => {
    if (directory === '/slow') await slow.promise;
    if (directory === '/bad') throw new Error('cannot read');
    return { isGitRepository: true, status: { current: 'main' } };
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/git/status/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directories: ['/slow', '/fast', '/bad'] }),
    });
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');
    const reader = response.body.getReader();
    let prefix = '';
    while (!prefix.includes('/bad') || !prefix.includes('/fast')) {
      const chunk = await reader.read();
      prefix += new TextDecoder().decode(chunk.value);
    }
    expect(prefix).not.toContain('/slow');
    expect(prefix).toContain('cannot read');
    slow.resolve();
    let suffix = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      suffix += new TextDecoder().decode(chunk.value);
    }
    expect(suffix).toContain('/slow');
  } finally {
    slow.resolve();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('bounds workers and stops admitting queued directories after disconnect', async () => {
  const gate = Promise.withResolvers();
  const admitted = [];
  const app = express();
  app.use(express.json());
  registerGitStatusBatchRoute(app, async (directory) => {
    admitted.push(directory);
    await gate.promise;
    return { isGitRepository: true, status: {} };
  });
  const server = createServer(app);
  const disconnected = Promise.withResolvers();
  server.on('request', (_req, res) => res.on('close', () => disconnected.resolve()));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/git/status/batch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ directories: Array.from({ length: 20 }, (_, i) => `/repo-${i}`) }),
    });
    expect(response.ok).toBe(true);
    expect(admitted).toHaveLength(4);
    controller.abort();
    await disconnected.promise;
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    expect(admitted).toHaveLength(4);
  } finally {
    gate.resolve();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
