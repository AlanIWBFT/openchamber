import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mock = vi.fn;

const listMock = mock(async () => ({ data: [] }));
const gitPrContextCalls = [];
const defaultGitPrContextImplementation = async () => ({ tracking: null, remotes: [] });
let gitPrContextImplementation = defaultGitPrContextImplementation;

vi.doMock('../git/index.js', () => ({
  getPrGitContext: async (...args) => {
    gitPrContextCalls.push(args);
    return gitPrContextImplementation(...args);
  },
}));

vi.doMock('./repo/index.js', () => ({
  parseGitHubRemoteUrl: () => null,
}));

vi.doMock('./rate-limit.js', () => ({
  noteIfGitHubRateLimit: () => {},
}));

const { findBranchPrCandidates, invalidateRepoPullsCache, resolveGitHubPrStatus } = await import('./pr-status.js');

const openPr = {
  number: 15,
  state: 'open',
  head: {
    ref: 'feature',
    label: 'acme:feature',
    user: { login: 'acme' },
    repo: { owner: { login: 'acme' }, name: 'app' },
  },
};

const mergedPr = {
  number: 12,
  state: 'closed',
  merged_at: '2026-01-01T00:00:00Z',
  head: {
    ref: 'feature',
    label: 'acme:feature',
    user: { login: 'acme' },
    repo: { owner: { login: 'acme' }, name: 'app' },
  },
};

const olderMergedPr = {
  ...mergedPr,
  number: 7,
  merged_at: '2025-11-01T00:00:00Z',
};

const call = (overrides = {}) => findBranchPrCandidates({
  octokit: { rest: { pulls: { list: listMock } } },
  target: { repo: { owner: 'acme', repo: 'app' }, remoteName: 'origin' },
  branch: 'feature',
  sourceCandidates: [{ repo: { owner: 'acme', repo: 'app' } }],
  force: true,
  includeHistory: true,
  ...overrides,
});

describe('resolveGitHubPrStatus', () => {
  beforeEach(() => {
    gitPrContextCalls.length = 0;
    gitPrContextImplementation = defaultGitPrContextImplementation;
  });

  test('requests only the narrow PR git context', async () => {
    const controller = new AbortController();
    const args = {
      octokit: { rest: { repos: { get: mock(async () => ({ data: null })) } } },
      directory: process.cwd(),
      branch: 'feature',
      signal: controller.signal,
    };

    await expect(resolveGitHubPrStatus(args)).resolves.toEqual({
      repo: null,
      pr: null,
      defaultBranch: null,
      resolvedRemoteName: null,
    });
    expect(gitPrContextCalls).toEqual([[process.cwd(), 'feature', { signal: controller.signal }]]);
  });

  test('propagates a temporarily unavailable Git worker to the route fallback', async () => {
    const unavailable = Object.assign(
      new Error('Git read worker is recovering from a timed-out process launch'),
      { code: 'GIT_READ_WORKER_UNAVAILABLE' },
    );
    gitPrContextImplementation = async () => { throw unavailable; };

    await expect(resolveGitHubPrStatus({
      octokit: { rest: { repos: { get: mock(async () => ({ data: null })) } } },
      directory: process.cwd(),
      branch: 'feature',
    })).rejects.toBe(unavailable);
  });
});

describe('findBranchPrCandidates', () => {
  beforeEach(() => {
    listMock.mockReset();
    invalidateRepoPullsCache('acme', 'app');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('an open PR wins and no history lookup is spent', async () => {
    listMock.mockImplementation(async ({ state }) => (
      state === 'open' ? { data: [openPr] } : { data: [mergedPr] }
    ));

    const { open, historical } = await call();

    expect(open?.number).toBe(15);
    expect(historical).toBeNull();
    expect(listMock.mock.calls.every((entry) => entry[0]?.state === 'open')).toBe(true);
  });

  test('an open PR still wins when the shared open list missed it', async () => {
    // A repo with more than one page of open PRs: the shared list is incomplete,
    // so the per-head query is the one that must find the open PR.
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr, openPr] } : { data: new Array(100).fill(null).map((_, index) => ({ number: index, state: 'open', head: { ref: 'other' } })) }
    ));

    const { open, historical } = await call();

    expect(open?.number).toBe(15);
    expect(historical).toBeNull();
  });

  test('returns the branch history when no open PR exists', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [olderMergedPr, mergedPr] } : { data: [] }
    ));

    const { open, historical } = await call();

    expect(open).toBeNull();
    // The newest past PR for the head is the relevant record.
    expect(historical?.number).toBe(12);
  });

  test('returns no history for a branch that never had a PR', async () => {
    listMock.mockImplementation(async () => ({ data: [] }));

    const { open, historical } = await call();

    expect(open).toBeNull();
    expect(historical).toBeNull();
    expect(listMock.mock.calls.some((entry) => entry[0]?.state === 'all')).toBe(true);
  });

  test('spends no call on history for a secondary target', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    const { open, historical } = await call({ includeHistory: false });

    expect(open).toBeNull();
    expect(historical).toBeNull();
    // The complete open list already answered the only question that matters
    // for a secondary repo in the fork network.
    expect(listMock.mock.calls).toHaveLength(1);
    expect(listMock.mock.calls[0]?.[0]?.state).toBe('open');
  });

  test('reuses the cached history instead of re-querying every poll', async () => {
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    // A non-forced poll is answered entirely from the shared open list cache
    // plus the remembered history — no extra GitHub call.
    const { open, historical } = await call({ force: false });

    expect(open).toBeNull();
    expect(historical?.number).toBe(12);
    expect(listMock.mock.calls.length).toBe(callsAfterFirst);
  });

  test('a found record outlives the shorter "no history" window', async () => {
    const startedAt = Date.now();
    listMock.mockImplementation(async ({ head }) => (
      head ? { data: [mergedPr] } : { data: [] }
    ));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    // Past the "no history" expiry, but far short of the found-record one. The
    // shared open list is re-fetched; the history answer is not re-queried.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt + 30 * 60 * 1000));
    const { historical } = await call({ force: false });

    expect(historical?.number).toBe(12);
    expect(listMock.mock.calls.length).toBe(callsAfterFirst + 1);
    expect(listMock.mock.calls.at(-1)?.[0]?.state).toBe('open');
  });

  test('re-queries a branch with no history once its shorter window passes', async () => {
    const startedAt = Date.now();
    listMock.mockImplementation(async () => ({ data: [] }));

    await call();
    const callsAfterFirst = listMock.mock.calls.length;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(startedAt + 30 * 60 * 1000));
    await call({ force: false });

    expect(listMock.mock.calls.some((entry) => entry[0]?.state === 'all')).toBe(true);
    expect(listMock.mock.calls.length).toBeGreaterThan(callsAfterFirst + 1);
  });
});
