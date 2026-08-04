import { describe, expect, test } from 'bun:test';
import { deriveBaseBranch, hasResolvableBaseBranch } from './baseBranch';

describe('deriveBaseBranch', () => {
  test('prefers the remote default branch hint over conventional fallbacks', () => {
    expect(deriveBaseBranch({
      remoteNames: new Set(['origin']),
      localBranches: ['next'],
      rootBranchHint: 'origin/react',
    })).toBe('react');
  });
});

describe('hasResolvableBaseBranch', () => {
  test('rejects the main fallback when it does not exist', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next', 'react'],
      remoteBranches: ['origin/next', 'origin/react'],
    })).toBe(false);
  });

  test('accepts a base branch available through a remote-tracking ref', () => {
    expect(hasResolvableBaseBranch({
      baseBranch: 'main',
      localBranches: ['next'],
      remoteBranches: ['origin/main', 'origin/next'],
    })).toBe(true);
  });
});
