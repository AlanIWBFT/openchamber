import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubDescriptor } from '../github/descriptor.js';
import { registerProviderRoutes } from './provider-routes.js';
import { createProviderDescriptors } from './provider-descriptors.js';
import { createSourceControlProviders } from './provider-registry.js';

const context = {
  instance: 'github.com', accountId: 'account-1', repositoryId: 'repo-1',
  bindingRevision: 1, primaryRemote: 'origin', directory: '/repo', branch: 'feature',
};

function fixture() {
  const read = vi.fn(async () => ({ connected: true, changeRequest: { number: 42 } }));
  const impl = {
    classifyFailure: () => 'provider-error',
    auth: { resolveAccount: async ({ accountId }) => ({ accountId, credentialRevision: 1 }) },
    resources: { changeRequestStatus: read },
  };
  const providers = createSourceControlProviders({
    descriptors: createProviderDescriptors([githubDescriptor]),
    loaders: { github: async () => ({ createProvider: () => impl }) },
  });
  const app = express();
  registerProviderRoutes(app, { providers, validateReadContext: async (input) => input });
  return { read, status: (overrides = {}) => request(app).get('/api/source-control/github/pr/status').query({ ...context, ...overrides }) };
}

afterEach(() => vi.useRealTimers());

describe('status deadline and worker recovery', () => {
  it('aborts provider work at the deadline without putting runtime options into JSON input', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { read, status } = fixture();
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    let input;
    let signal;
    read.mockImplementation((value, options) => {
      input = value;
      signal = options.signal;
      started();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const pending = status().then((response) => response);
    await ready;
    expect(input).not.toHaveProperty('signal');
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.code).toBe('ETIMEDOUT');
    expect((await pending).status).toBe(503);
  });

  it.each(['GIT_READ_WORKER_UNAVAILABLE', 'ETIMEDOUT'])('keeps only the exact authority cached after %s', async (code) => {
    const { read, status } = fixture();
    const initial = await status().expect(200);
    read.mockRejectedValue(Object.assign(new Error('worker is recovering'), { code }));
    expect((await status({ force: 'true' }).expect(200)).body).toEqual(initial.body);
    for (const changed of [{ accountId: 'account-2' }, { bindingRevision: 2 }, { repositoryId: 'repo-2' }]) {
      await status(changed).expect(503);
    }
  });
});
