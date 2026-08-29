import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getFileDiff: vi.fn(),
};

afterEach(() => {
  vi.useRealTimers();
});

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  getFileDiff: gitLibraries.getFileDiff,
}));

const { registerGitRoutes } = await import('./routes.js');
const { runGitStatusTask } = await import('./status-tasks.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const waitForCalls = async (mock, count) => {
  for (let index = 0; index < 100 && mock.mock.calls.length !== count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(mock).toHaveBeenCalledTimes(count);
};

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
  });

  it('returns a soft non-repo payload for non-git folders', async () => {
    gitLibraries.getStatus.mockRejectedValue(new Error('fatal: not a git repository (or any of the parent directories): .git'));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/tmp/not-a-repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      isGitRepository: false,
      current: '',
      tracking: null,
      files: [],
      isClean: true,
      ahead: 0,
      behind: 0,
    });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/tmp/not-a-repo', expect.objectContaining({
      mode: undefined,
      signal: expect.anything(),
    }));
  });

  it('does not abort when getStatus throws a non-repo GitError', async () => {
    gitLibraries.getStatus.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository (or any of the parent directories): .git'), {
        task: { commands: ['status'] },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ isGitRepository: false });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', expect.objectContaining({
      mode: undefined,
      signal: expect.anything(),
    }));
  });

  it('uses the opened project path from query arrays without falling back to cwd', async () => {
    gitLibraries.getStatus.mockResolvedValue({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: ['/opened/git-project', '/ignored'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', expect.objectContaining({
      mode: undefined,
      signal: expect.anything(),
    }));
    expect(response.body).toMatchObject({ current: 'main' });
  });

  it('shares concurrent passive status discovery for the same directory and mode', async () => {
    let resolveStatus;
    gitLibraries.getStatus.mockImplementation(() => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/status/passive');
    const firstResponse = createMockResponse();
    const secondResponse = createMockResponse();

    const firstRequest = route({ query: { directory: '/opened/project' } }, firstResponse);
    const secondRequest = route({ query: { directory: '/opened/project' } }, secondResponse);

    await waitForCalls(gitLibraries.getStatus, 1);
    resolveStatus({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    await Promise.all([firstRequest, secondRequest]);

    expect(firstResponse.body).toMatchObject({ current: 'main' });
    expect(secondResponse.body).toMatchObject({ current: 'main' });

    gitLibraries.getStatus.mockResolvedValueOnce({ current: 'feature', files: [], isClean: true, ahead: 0, behind: 0 });
    const laterResponse = createMockResponse();
    await route({ query: { directory: '/opened/project' } }, laterResponse);

    expect(gitLibraries.getStatus).toHaveBeenCalledTimes(2);
    expect(laterResponse.body).toMatchObject({ current: 'feature' });
  });

  it('joins a passive status task started outside the git route', async () => {
    let resolveStatus;
    const taskDirectory = process.platform === 'win32' ? 'C:\\opened\\project' : '/opened/project';
    const requestDirectory = process.platform === 'win32' ? 'C:/opened/project' : '/opened/project';
    const sharedTask = runGitStatusTask(taskDirectory, {}, () => new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    const request = getRoute('GET', '/api/git/status/passive')(
      { query: { directory: requestDirectory } },
      response,
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(gitLibraries.getStatus).not.toHaveBeenCalled();
    resolveStatus({ current: 'shared', files: [], isClean: true, ahead: 0, behind: 0 });
    await Promise.all([sharedTask, request]);
    expect(response.body).toMatchObject({ current: 'shared' });
  });

  it('starts an authoritative status read while an older passive read is active', async () => {
    let resolvePassiveStatus;
    let resolveAuthoritativeStatus;
    gitLibraries.getStatus
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolvePassiveStatus = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveAuthoritativeStatus = resolve;
      }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const passiveResponse = createMockResponse();
    const authoritativeResponse = createMockResponse();

    const passiveRequest = getRoute('GET', '/api/git/status/passive')(
      { query: { directory: '/opened/project' } },
      passiveResponse,
    );
    await waitForCalls(gitLibraries.getStatus, 1);

    const authoritativeRequest = getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      authoritativeResponse,
    );
    await waitForCalls(gitLibraries.getStatus, 2);
    const laterPassiveResponse = createMockResponse();
    const laterPassiveRequest = getRoute('GET', '/api/git/status/passive')(
      { query: { directory: '/opened/project' } },
      laterPassiveResponse,
    );
    expect(gitLibraries.getStatus).toHaveBeenCalledTimes(2);
    resolveAuthoritativeStatus({ current: 'fresh', files: [], isClean: true, ahead: 0, behind: 0 });
    await Promise.all([authoritativeRequest, laterPassiveRequest]);
    expect(authoritativeResponse.body).toMatchObject({ current: 'fresh' });
    expect(laterPassiveResponse.body).toMatchObject({ current: 'fresh' });
    resolvePassiveStatus({ current: 'old', files: [], isClean: true, ahead: 0, behind: 0 });
    await passiveRequest;
    expect(passiveResponse.body).toMatchObject({ current: 'old' });
  });

  it('aborts a timed-out passive status task and allows later demand to retry', async () => {
    vi.useFakeTimers();
    let abortReason;
    gitLibraries.getStatus
      .mockImplementationOnce((_directory, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          abortReason = options.signal.reason;
          reject(options.signal.reason);
        }, { once: true });
      }))
      .mockResolvedValueOnce({ current: 'recovered', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/status/passive');
    const timedOutResponse = createMockResponse();

    const timedOutRequest = route({ query: { directory: '/opened/project' } }, timedOutResponse);
    await waitForCalls(gitLibraries.getStatus, 1);
    vi.advanceTimersByTime(30_000);
    await timedOutRequest;

    expect(abortReason).toMatchObject({ code: 'GIT_STATUS_TIMEOUT' });
    expect(timedOutResponse.statusCode).toBe(504);
    expect(timedOutResponse.body).toEqual({ error: 'Git status timed out after 30000ms' });

    const recoveredResponse = createMockResponse();
    await route({ query: { directory: '/opened/project' } }, recoveredResponse);

    expect(gitLibraries.getStatus).toHaveBeenCalledTimes(2);
    expect(recoveredResponse.body).toMatchObject({ current: 'recovered' });
  });

  it('returns 503 while the Windows Git worker circuit is open', async () => {
    gitLibraries.getStatus.mockRejectedValueOnce(Object.assign(
      new Error('Git read worker is recovering from a timed-out process launch'),
      { code: 'GIT_READ_WORKER_UNAVAILABLE' },
    ));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status/passive')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Git read worker is recovering from a timed-out process launch' });
  });
});

describe('git file diff worker availability', () => {
  beforeEach(() => {
    gitLibraries.getFileDiff.mockReset();
  });

  it('returns 503 while every Windows Git worker lane is recovering', async () => {
    gitLibraries.getFileDiff.mockRejectedValue(Object.assign(
      new Error('Git read worker is recovering from a timed-out process launch'),
      { code: 'GIT_READ_WORKER_UNAVAILABLE' },
    ));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/file-diff')(
      { query: { directory: '/repo', path: 'file.txt' } },
      response,
    );

    expect(response.statusCode).toBe(503);
    expect(response.body).toEqual({ error: 'Git read worker is recovering from a timed-out process launch' });
  });

  it('aborts a file diff that exceeds the hard deadline', async () => {
    vi.useFakeTimers();
    let abortReason;
    gitLibraries.getFileDiff.mockImplementation((_directory, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        abortReason = options.signal.reason;
        reject(options.signal.reason);
      }, { once: true });
    }));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    const request = getRoute('GET', '/api/git/file-diff')(
      { query: { directory: '/repo', path: 'file.txt' } },
      response,
    );
    await waitForCalls(gitLibraries.getFileDiff, 1);
    vi.advanceTimersByTime(30_000);
    await request;

    expect(abortReason).toMatchObject({ code: 'GIT_FILE_DIFF_TIMEOUT' });
    expect(response.statusCode).toBe(504);
    expect(response.body).toEqual({ error: 'Git file diff timed out after 30000ms' });
  });
});
