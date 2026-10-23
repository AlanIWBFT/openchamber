import { describe, expect, it, vi } from 'vitest';
import { readBranchChangeIds, readBranchTip } from './change-id.js';
import { readUpstreamBranch } from '../gerrit/local-revision.js';

describe('Change-Id read ownership', () => {
  it('rejects a cancelled tip probe instead of reporting an unknown tip', async () => {
    const controller = new AbortController();
    const reason = Object.assign(new Error('expired'), { code: 'ETIMEDOUT' });
    controller.abort(reason);
    const git = vi.fn();
    await expect(readBranchTip('/repo', 'main', { git, signal: controller.signal })).rejects.toBe(reason);
    expect(git).not.toHaveBeenCalled();
  });

  it.each(['signal', 'shared'])('does not start another command after %s cancellation during a read', async (kind) => {
    const controller = new AbortController();
    const cancellationView = new Int32Array(new SharedArrayBuffer(4));
    const git = vi.fn(async () => {
      if (kind === 'signal') controller.abort(Object.assign(new Error('expired'), { code: 'ETIMEDOUT' }));
      else Atomics.store(cancellationView, 0, 1);
      return 'a'.repeat(40);
    });
    await expect(readBranchChangeIds('/repo', 'main', null, { git, signal: controller.signal, cancellationView }))
      .rejects.toMatchObject({ code: kind === 'signal' ? 'ETIMEDOUT' : 'ABORT_ERR' });
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('does not turn an aborted upstream probe into an untracked branch', async () => {
    const controller = new AbortController();
    const reason = new Error('expired');
    const git = vi.fn(async () => { controller.abort(reason); return 'origin'; });
    await expect(readUpstreamBranch('/repo', 'main', 'origin', { git, signal: controller.signal })).rejects.toBe(reason);
    expect(git).toHaveBeenCalledTimes(1);
  });

  it('preserves a process deadline before the caller deadline expires', async () => {
    const reason = Object.assign(new Error('Git timed out'), { code: 'ETIMEDOUT' });
    const git = vi.fn(async () => { throw reason; });
    await expect(readUpstreamBranch('/repo', 'main', 'origin', { git })).rejects.toBe(reason);
    await expect(readBranchTip('/repo', 'main', { git })).rejects.toBe(reason);
    expect(git).toHaveBeenCalledTimes(2);
  });

  it('waits for every trailer command before acknowledging a failed stack read', async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const failure = new Error('first trailer failed');
    const git = vi.fn(async (_directory, args, options) => {
      if (args[0] === 'rev-parse') return 'a'.repeat(40);
      if (args[0] === 'log') return `${'a'.repeat(40)}\nfirst\0${'b'.repeat(40)}\nsecond\0`;
      if (options.input === 'first') throw failure;
      await held;
      return '';
    });
    let settled = false;
    const pending = readBranchChangeIds('/repo', 'main', 'base', { git }).catch((error) => { settled = true; return error; });
    await vi.waitFor(() => expect(git).toHaveBeenCalledTimes(5));
    expect(settled).toBe(false);
    release();
    expect(await pending).toBe(failure);
  });
});
