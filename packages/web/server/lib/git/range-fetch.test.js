import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { fetchMissingRangeRef } from './range-fetch.js';

const fixture = () => {
  const remote = { name: 'origin', fetch: { fingerprint: 'fetch' }, push: { fingerprint: 'push' } };
  const read = {
    revision: 2, repository: { repositoryId: 'repo', configRevision: 'config', remotes: [remote] },
    binding: { repositoryId: 'repo', revision: 2, remotes: [{ ...remote, mode: 'managed', readiness: 'ready' }] },
  };
  const response = Object.assign(new EventEmitter(), { destroyed: false, setHeader: vi.fn() });
  const networkOperations = {
    plan: vi.fn(async () => ({ operationId: 'op' })),
    execute: vi.fn(async () => ({ state: 'succeeded' })),
    cancel: vi.fn(async () => ({ state: 'cancelled' })),
  };
  const input = { directory: '/repo', remote: 'origin', branch: 'parent', response, getSourceControlBinding: vi.fn(async () => read), networkOperations };
  return { read, input, response, networkOperations };
};

describe('missing comparison ref transfer ownership', () => {
  it('pins the exact bound branch and exposes its registered operation', async () => {
    const { input, response, networkOperations } = fixture();
    await fetchMissingRangeRef(input);
    expect(networkOperations.plan).toHaveBeenCalledWith({
      operation: 'fetch', fetchScope: 'ref', directory: '/repo', repositoryId: 'repo', bindingRevision: 2, configRevision: 'config',
      remote: { name: 'origin', endpoint: { fingerprint: 'fetch' } }, transportMode: 'managed',
      sourceRef: 'refs/heads/parent', destinationRef: 'refs/remotes/origin/parent',
    });
    expect(response.setHeader).toHaveBeenCalledWith('X-OpenChamber-Git-Operation', 'op');
    expect(networkOperations.execute).toHaveBeenCalledWith('op');
    expect(response.listenerCount('close')).toBe(0);
  });

  it.each(['missing', 'stale'])('refuses a %s binding instead of using ambient credentials', async (state) => {
    const { input, read, networkOperations } = fixture();
    if (state === 'missing') read.binding = null;
    else read.binding.revision++;
    await expect(fetchMissingRangeRef(input)).rejects.toMatchObject({ code: 'SOURCE_CONTROL_BINDING_REQUIRED' });
    expect(networkOperations.plan).not.toHaveBeenCalled();
  });

  it('cancels a plan returned after the comparison closed without executing it', async () => {
    const { input, response, networkOperations } = fixture();
    const plan = Promise.withResolvers();
    networkOperations.plan.mockReturnValue(plan.promise);
    const run = fetchMissingRangeRef(input);
    const assertion = expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(networkOperations.plan).toHaveBeenCalled());
    response.emit('close');
    plan.resolve({ operationId: 'op' });
    await assertion;
    expect(networkOperations.cancel).toHaveBeenCalledWith('op');
    expect(networkOperations.execute).not.toHaveBeenCalled();
  });

  it('cancels the owned running operation and awaits its terminal result', async () => {
    const { input, response, networkOperations } = fixture();
    const execution = Promise.withResolvers();
    networkOperations.execute.mockReturnValue(execution.promise);
    networkOperations.cancel.mockImplementation(async () => { execution.resolve({ state: 'cancelled' }); });
    const run = fetchMissingRangeRef(input);
    const assertion = expect(run).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(networkOperations.execute).toHaveBeenCalled());
    response.emit('close');
    await assertion;
    expect(networkOperations.cancel).toHaveBeenCalledTimes(1);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('propagates the existing executor deadline as a failed comparison', async () => {
    const { input, networkOperations } = fixture();
    networkOperations.execute.mockResolvedValue({ state: 'cancelled', error: { code: 'TIMEOUT', message: 'timed out' } });
    await expect(fetchMissingRangeRef(input)).rejects.toMatchObject({ code: 'TIMEOUT', operationId: 'op' });
  });
});
