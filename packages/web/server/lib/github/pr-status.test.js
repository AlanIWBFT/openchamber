import { beforeEach, describe, expect, mock, test } from 'bun:test';

const listMock = mock(async () => ({ data: [] }));

mock.module('../git/index.js', () => ({
  getRemotes: async () => [],
  getStatus: async () => null,
}));

mock.module('./repo/index.js', () => ({
  resolveGitHubRepoFromDirectory: async () => null,
}));

mock.module('./rate-limit.js', () => ({
  noteIfGitHubRateLimit: () => {},
}));

const { findFirstMatchingPr, invalidateRepoPullsCache } = await import('./pr-status.js');

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

const closedPr = {
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

describe('findFirstMatchingPr open-only branch status', () => {
  beforeEach(() => {
    listMock.mockReset();
    invalidateRepoPullsCache('acme', 'app');
  });

  test('returns a matching open PR', async () => {
    listMock.mockImplementation(async ({ state }) => {
      if (state === 'open') {
        return { data: [openPr] };
      }
      return { data: [closedPr] };
    });

    const pr = await findFirstMatchingPr({
      octokit: { rest: { pulls: { list: listMock } } },
      target: { repo: { owner: 'acme', repo: 'app' }, remoteName: 'origin' },
      branch: 'feature',
      sourceCandidates: [{ repo: { owner: 'acme', repo: 'app' } }],
      force: true,
    });

    expect(pr?.number).toBe(15);
    expect(listMock.mock.calls.every((call) => call[0]?.state === 'open')).toBe(true);
  });

  test('returns null when only a closed/merged PR exists for the head branch', async () => {
    listMock.mockImplementation(async ({ state }) => {
      if (state === 'open') {
        return { data: [] };
      }
      return { data: [closedPr] };
    });

    const pr = await findFirstMatchingPr({
      octokit: { rest: { pulls: { list: listMock } } },
      target: { repo: { owner: 'acme', repo: 'app' }, remoteName: 'origin' },
      branch: 'feature',
      sourceCandidates: [{ repo: { owner: 'acme', repo: 'app' } }],
      force: true,
    });

    expect(pr).toBeNull();
    expect(listMock.mock.calls.every((call) => call[0]?.state === 'open')).toBe(true);
    expect(listMock.mock.calls.some((call) => call[0]?.state === 'closed')).toBe(false);
  });
});
