import { beforeEach, describe, expect, test } from 'bun:test';
import type { GitStatus } from '@/lib/api/types';
import { useGitStore } from './useGitStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { notifyGitStatusInvalidated } from '@/lib/gitStatusInvalidation';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

type GitAPI = Parameters<ReturnType<typeof useGitStore.getState>['fetchStatus']>[1];
type DirectoryGitState = NonNullable<ReturnType<ReturnType<typeof useGitStore.getState>['getDirectoryState']>>;

const createDeferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const createStatus = (diffStats?: GitStatus['diffStats'], files: GitStatus['files'] = []): GitStatus => ({
  current: 'main',
  tracking: null,
  ahead: 0,
  behind: 0,
  files,
  isClean: files.length === 0,
  diffStats,
});

const createDirectoryState = (status: GitStatus): DirectoryGitState => ({
  isGitRepo: true,
  status,
  branches: null,
  log: null,
  identity: null,
  diffCache: new Map(),
  indexRevision: 0,
  lastRepoCheckAt: Date.now(),
  lastStatusFetch: 0,
  lastStatusChange: 0,
  lastLogFetch: 0,
  lastBranchesFetch: 0,
  lastIdentityFetch: 0,
  logMaxCount: 25,
  isLoadingStatus: false,
  isLoadingLog: false,
  isLoadingBranches: false,
  isLoadingIdentity: false,
});

const setDirectoryStatus = (status: GitStatus) => {
  useGitStore.setState({
    directories: new Map([['/repo', createDirectoryState(status)]]),
    activeDirectory: '/repo',
  });
};

const createGitApi = (getGitStatus: GitAPI['getGitStatus'], getPassiveGitStatus?: GitAPI['getPassiveGitStatus']): GitAPI => ({
  checkIsGitRepository: async () => true,
  getGitStatus,
  getPassiveGitStatus,
  getGitBranches: async () => ({ all: [], current: 'main', branches: {} }),
  getGitLog: async () => ({ all: [], latest: null, total: 0 }),
  getCurrentGitIdentity: async () => null,
  getGitFileDiff: async (_directory, options) => ({ original: '', modified: '', path: options.path }),
});

describe('useGitStore', () => {
  beforeEach(() => {
    useGitStore.getState().resetForRuntimeSwitch(getRuntimeKey());
  });

  test('does not reuse an in-flight light status request for full status', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    const statusCalls: Array<{ directory: string; options?: { mode?: 'light' } }> = [];
    const git = createGitApi((directory, options) => {
      statusCalls.push({ directory, options });
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const lightPromise = useGitStore.getState().fetchStatus('/repo', git, { mode: 'light', silent: true });
    const fullPromise = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();

    expect(statusCalls).toEqual([
      { directory: '/repo', options: { mode: 'light' } },
      { directory: '/repo', options: undefined },
    ]);

    requests[1].resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await fullPromise;
    requests[0].resolve(createStatus());
    await lightPromise;

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.diffStats).toEqual({
      'src/index.ts': { insertions: 1, deletions: 0 },
    });
  });

  test('uses the passive reader for mounted status demand', async () => {
    setDirectoryStatus(createStatus());
    let authoritativeCalls = 0;
    let passiveCalls = 0;
    const passiveRequest = createDeferred<GitStatus>();
    const git = createGitApi(
      async () => {
        authoritativeCalls += 1;
        return createStatus();
      },
      async () => {
        passiveCalls += 1;
        return passiveRequest.promise;
      },
    );

    const first = useGitStore.getState().ensurePassiveStatus('/repo', git);
    const second = useGitStore.getState().ensurePassiveStatus('/repo', git);
    await Promise.resolve();

    expect(authoritativeCalls).toBe(0);
    expect(passiveCalls).toBe(1);
    passiveRequest.resolve(createStatus({ 'src/index.ts': { insertions: 1, deletions: 0 } }));
    await Promise.all([first, second]);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.diffStats).toEqual({
      'src/index.ts': { insertions: 1, deletions: 0 },
    });
  });

  test('deduplicates concurrent passive status requests when no mutation occurs', async () => {
    setDirectoryStatus(createStatus());
    let statusCalls = 0;
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => {
      statusCalls += 1;
      return request.promise;
    });

    const first = useGitStore.getState().ensurePassiveStatus('/repo', git);
    const second = useGitStore.getState().ensurePassiveStatus('/repo', git);
    await Promise.resolve();

    expect(statusCalls).toBe(1);

    request.resolve(createStatus());
    await Promise.all([first, second]);
    expect(statusCalls).toBe(1);
  });

  test('a refresh after a mutation does not join the pre-mutation in-flight status request', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    let statusCalls = 0;
    const git = createGitApi(() => {
      statusCalls += 1;
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const preMutation = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    // A successful git mutation invalidates the adapter status cache, which
    // notifies the store that the in-flight request predates the mutation.
    notifyGitStatusInvalidated('/repo');

    const postMutation = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(2);

    requests[1].resolve({ ...createStatus(), current: 'feature' });
    await postMutation;
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');

    // The late pre-mutation response cannot overwrite the newer authoritative one.
    requests[0].resolve(createStatus());
    await preMutation;
    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');
  });

  test('fetchAll({ force: true }) forces a fresh status fetch past the in-flight dedup', async () => {
    setDirectoryStatus(createStatus());
    const requests: Deferred<GitStatus>[] = [];
    let statusCalls = 0;
    const git = createGitApi(() => {
      statusCalls += 1;
      const request = createDeferred<GitStatus>();
      requests.push(request);
      return request.promise;
    });

    const inFlight = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    const all = useGitStore.getState().fetchAll('/repo', git, { force: true });
    await Promise.resolve();
    expect(statusCalls).toBe(2);

    requests[1].resolve({ ...createStatus(), current: 'feature' });
    requests[0].resolve(createStatus());
    await Promise.allSettled([inFlight, all]);

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.current).toBe('feature');
  });

  test('does not let an older status fetch undo an optimistic mutation', async () => {
    const initial = createStatus(undefined, [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }]);
    setDirectoryStatus(initial);
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => request.promise);

    const loading = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    request.resolve(initial);
    await loading;

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]);
  });

  test('starts an authoritative refresh while an older passive read is active', async () => {
    const initial = createStatus(undefined, [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }]);
    const staged = createStatus(undefined, [{ path: 'src/index.ts', index: 'M', working_dir: ' ' }]);
    setDirectoryStatus(initial);
    const passiveRequest = createDeferred<GitStatus>();
    const authoritativeRequest = createDeferred<GitStatus>();
    let authoritativeCalls = 0;
    let passiveCalls = 0;
    const git = createGitApi(
      () => {
        authoritativeCalls += 1;
        return authoritativeRequest.promise;
      },
      () => {
        passiveCalls += 1;
        return passiveCalls === 1 ? passiveRequest.promise : authoritativeRequest.promise;
      },
    );

    const passive = useGitStore.getState().ensurePassiveStatus('/repo', git);
    await Promise.resolve();
    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const authoritative = useGitStore.getState().fetchStatus('/repo', git, { silent: true });
    const laterPassive = useGitStore.getState().ensurePassiveStatus('/repo', git);

    expect(authoritativeCalls).toBe(1);
    expect(passiveCalls).toBe(2);
    authoritativeRequest.resolve(staged);
    await Promise.all([authoritative, laterPassive]);
    passiveRequest.resolve(initial);
    await passive;

    expect(useGitStore.getState().getDirectoryState('/repo')?.status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]);
  });

  test('rejects an old runtime completion after reset', async () => {
    setDirectoryStatus(createStatus());
    const request = createDeferred<GitStatus>();
    const git = createGitApi(() => request.promise);
    const loading = useGitStore.getState().fetchStatus('/repo', git, { silent: true });

    useGitStore.getState().resetForRuntimeSwitch('runtime-b');
    request.resolve(createStatus(undefined, [{ path: 'stale.ts', index: 'M', working_dir: ' ' }]));
    await loading;

    expect(useGitStore.getState().runtimeKey).toBe('runtime-b');
    expect(useGitStore.getState().getDirectoryState('/repo')?.status ?? null).toBe(null);
  });

  test('rejects direct diff commits captured for another runtime', () => {
    useGitStore.getState().setDiff('/repo', 'stale.ts', { original: 'a', modified: 'b' }, 'runtime-a');
    expect(useGitStore.getState().getDiff('/repo', 'stale.ts')).toBe(null);
  });

  test('clears cached file contents when a git refresh hint invalidates diffs', () => {
    setDirectoryStatus(createStatus(
      { 'src/index.ts': { insertions: 1, deletions: 1 } },
      [{ path: 'src/index.ts', index: ' ', working_dir: 'M' }],
    ));
    useGitStore.getState().setDiff('/repo', 'src/index.ts', { original: 'old', modified: 'stale' });

    useGitStore.getState().clearDiffCache('/repo');

    expect(useGitStore.getState().getDiff('/repo', 'src/index.ts')).toBe(null);
  });

  test('invalidates only the requested cached file contents', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'src/first.ts', index: ' ', working_dir: 'M' },
      { path: 'src/second.ts', index: ' ', working_dir: 'M' },
    ]));
    useGitStore.getState().setDiff('/repo', 'src/first.ts', { original: 'a', modified: 'b' });
    useGitStore.getState().setDiff('/repo', 'src/second.ts', { original: 'c', modified: 'd' });

    useGitStore.getState().clearDiffCache('/repo', ['src/first.ts']);

    expect(useGitStore.getState().getDiff('/repo', 'src/first.ts')).toBe(null);
    expect(useGitStore.getState().getDiff('/repo', 'src/second.ts')?.modified).toBe('d');
  });

  test('keeps the newest branch request when completions are reversed', async () => {
    const requests = [createDeferred<Awaited<ReturnType<GitAPI['getGitBranches']>>>(), createDeferred<Awaited<ReturnType<GitAPI['getGitBranches']>>>()];
    let index = 0;
    const git = {
      ...createGitApi(async () => createStatus()),
      getGitBranches: () => requests[index++].promise,
    };
    const first = useGitStore.getState().fetchBranches('/repo', git);
    const second = useGitStore.getState().fetchBranches('/repo', git);

    requests[1].resolve({ all: ['new'], current: 'new', branches: {} });
    await second;
    requests[0].resolve({ all: ['old'], current: 'old', branches: {} });
    await first;

    expect(useGitStore.getState().getDirectoryState('/repo')?.branches?.current).toBe('new');
  });

  test('optimistically stages modified files and preserves untouched file references', () => {
    const target = { path: 'src/index.ts', index: ' ', working_dir: 'M' };
    const untouched = { path: 'README.md', index: ' ', working_dir: 'M' };
    const initialStatus = createStatus(undefined, [target, untouched]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;
    const state = useGitStore.getState().getDirectoryState('/repo');

    expect(previousStatus).toBe(initialStatus);
    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
      untouched,
    ]);
    expect(status?.files[1]).toBe(untouched);
    expect(state?.indexRevision).toBe(1);
  });

  test('optimistically stages untracked files as added files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: '?', working_dir: '?' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]);
  });

  test('optimistically unstages staged files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'src/index.ts', index: 'M', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
  });

  test('optimistically unstages staged added files back to untracked files', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'new-file.ts', index: 'A', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['new-file.ts'], 'unstage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([
      { path: 'new-file.ts', index: ' ', working_dir: '?' },
    ]);
  });

  test('keeps conflicted files unchanged during optimistic moves', () => {
    const conflicted = { path: 'conflict.ts', index: 'U', working_dir: 'U' };
    setDirectoryStatus(createStatus(undefined, [conflicted]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['conflict.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([conflicted]);
    expect(status?.files[0]).toBe(conflicted);
  });

  test('preserves diff stats during optimistic moves', () => {
    const diffStats = { 'src/index.ts': { insertions: 2, deletions: 1 } };
    setDirectoryStatus(createStatus(diffStats, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.diffStats).toBe(diffStats);
  });

  test('does nothing when optimistic move has no matching path', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['missing.ts'], 'stage');

    expect(previousStatus).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
    expect(useGitStore.getState().getDirectoryState('/repo')?.indexRevision).toBe(0);
  });

  test('does nothing without status for optimistic moves', () => {
    useGitStore.setState({
      directories: new Map([['/repo', { ...createDirectoryState(createStatus()), status: null }]]),
      activeDirectory: '/repo',
    });

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');

    expect(previousStatus).toBeNull();
    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBeNull();
  });

  test('removes entries that become clean during optimistic moves', () => {
    setDirectoryStatus(createStatus(undefined, [
      { path: 'clean.ts', index: ' ', working_dir: ' ' },
    ]));

    useGitStore.getState().moveStatusPathsOptimistically('/repo', ['clean.ts'], 'stage');
    const status = useGitStore.getState().getDirectoryState('/repo')?.status;

    expect(status?.files).toEqual([]);
    expect(status?.isClean).toBe(true);
  });

  test('restores previous status for optimistic rollback', () => {
    const initialStatus = createStatus(undefined, [
      { path: 'src/index.ts', index: ' ', working_dir: 'M' },
    ]);
    setDirectoryStatus(initialStatus);

    const previousStatus = useGitStore.getState().moveStatusPathsOptimistically('/repo', ['src/index.ts'], 'stage');
    useGitStore.getState().restoreStatus('/repo', previousStatus);

    expect(useGitStore.getState().getDirectoryState('/repo')?.status).toBe(initialStatus);
  });
});
