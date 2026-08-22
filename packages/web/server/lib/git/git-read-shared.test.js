import { describe, expect, it, vi } from 'vitest';

import { runSharedGitReadTask } from './git-read-shared.js';

describe('runSharedGitReadTask', () => {
  it('does not start work for an already-cancelled caller', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled before dispatch');
    controller.abort(reason);
    const taskFactory = vi.fn();

    await expect(runSharedGitReadTask('cancelled-before-dispatch', taskFactory, {
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(taskFactory).not.toHaveBeenCalled();
  });

  it('coalesces concurrent readers for the same key', async () => {
    let finish;
    const taskFactory = vi.fn(() => new Promise((resolve) => {
      finish = resolve;
    }));

    const first = runSharedGitReadTask('coalesce', taskFactory);
    const second = runSharedGitReadTask('coalesce', taskFactory);
    await Promise.resolve();

    expect(taskFactory).toHaveBeenCalledTimes(1);
    finish({ tracking: 'origin/feature' });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { tracking: 'origin/feature' },
      { tracking: 'origin/feature' },
    ]);
  });

  it('keeps shared work alive while another waiter remains', async () => {
    let finish;
    let taskSignal;
    const taskFactory = (signal) => {
      taskSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const firstController = new AbortController();
    const first = runSharedGitReadTask('one-waiter-cancelled', taskFactory, { signal: firstController.signal });
    const second = runSharedGitReadTask('one-waiter-cancelled', taskFactory);
    const timeout = new Error('first waiter timed out');

    firstController.abort(timeout);
    await expect(first).rejects.toBe(timeout);
    expect(taskSignal.aborted).toBe(false);
    finish('complete');
    await expect(second).resolves.toBe('complete');
  });

  it('cancels underlying work after the last waiter leaves', async () => {
    let taskSignal;
    const taskFactory = (signal) => {
      taskSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    };
    const controller = new AbortController();
    const pending = runSharedGitReadTask('all-waiters-cancelled', taskFactory, { signal: controller.signal });
    await Promise.resolve();
    const timeout = new Error('all waiters timed out');

    controller.abort(timeout);
    await expect(pending).rejects.toBe(timeout);
    expect(taskSignal.aborted).toBe(true);
    expect(taskSignal.reason).toBe(timeout);
  });
});
