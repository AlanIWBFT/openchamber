import { describe, expect, it } from 'vitest';

import { resolveControlTimeoutMs } from './cli-control.js';

describe('resolveControlTimeoutMs', () => {
  it('keeps the short default HTTP timeout for instant control calls', () => {
    expect(resolveControlTimeoutMs({}, {})).toBeUndefined();
    expect(resolveControlTimeoutMs({ wait: false, timeout: 30 }, {})).toBeUndefined();
  });

  it('outlives the default server wait window when wait is set', () => {
    expect(resolveControlTimeoutMs({ wait: true }, {})).toBe(630_000);
  });

  it('derives the HTTP timeout from an explicit wait timeout in seconds', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, {})).toBe(60_000);
  });

  it('never shrinks an explicitly requested HTTP timeout', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30 }, { timeoutMs: 5000 })).toBe(5000);
  });

  it('allows a worktree to be provisioned without waiting for the session', () => {
    expect(resolveControlTimeoutMs({ worktree: 'feature' }, {})).toBe(120_000);
  });

  it('ignores a blank worktree name', () => {
    expect(resolveControlTimeoutMs({ worktree: '   ' }, {})).toBeUndefined();
  });

  it('covers worktree provisioning even when the wait window is shorter', () => {
    expect(resolveControlTimeoutMs({ wait: true, timeout: 30, worktree: 'feature' }, {})).toBe(120_000);
  });

  it('keeps a longer wait window when it outlasts worktree provisioning', () => {
    expect(resolveControlTimeoutMs({ wait: true, worktree: 'feature' }, {})).toBe(630_000);
  });
});
