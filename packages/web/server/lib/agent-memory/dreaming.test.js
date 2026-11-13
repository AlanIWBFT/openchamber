import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHiddenSessionRegistry } from '../opencode/hidden-sessions.js';
import { createAgentMemoryRuntime } from './runtime.js';
import { buildDreamPrompt, createMemoryDreaming, diffDream } from './dreaming.js';

const PROJECT_DIR = '/work/acme';
const PROJECT_ID = 'path_acme';
const PROJECT = { scope: 'project', projectId: PROJECT_ID };
const DAY = 24 * 60 * 60 * 1000;

let rootDir;
let memory;
let idCounter;

beforeEach(async () => {
  rootDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'oc-dreaming-'));
  idCounter = 0;
  memory = createAgentMemoryRuntime({
    fsPromises,
    path,
    userConfigRoot: path.join(rootDir, 'config'),
    projectsDirPath: path.join(rootDir, 'config', 'projects'),
    createId: () => `mem-${++idCounter}`,
  });
});

afterEach(async () => {
  await fsPromises.rm(rootDir, { recursive: true, force: true });
});

const WORDS = ['amber', 'basalt', 'cobalt', 'dune', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'jasper', 'kelp', 'lagoon', 'meadow', 'nickel'];

const fill = async (count) => {
  for (let index = 0; index < count; index += 1) {
    const word = WORDS[index];
    await memory.create(PROJECT, { title: `Fact ${index}`, body: `${word} ${word}stone ${word}field ${word}wood` });
  }
};

/**
 * A stand-in OpenCode: records each request, answers the routes a pass uses,
 * and plays the agent on `prompt` through `onPrompt`.
 */
const createOpenCode = ({ active = {}, onPrompt = async () => {}, reply = 'Done.\nDREAM {"project": 1, "global": 0, "toDocs": ["mem-6", "mem-3"]}', hangWait = false } = {}) => {
  // The pass's own session reads as running for one look after its prompt, or for good with `hangWait`.
  let runningLooks = 0;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, pathname, search, body, headers: init.headers });
    const json = (value) => new Response(JSON.stringify(value), { status: 200 });
    if (method === 'GET' && pathname === '/api/session/active') {
      const prompt = calls.find((call) => call.method === 'POST' && call.pathname.endsWith('/prompt'));
      if (!prompt) return json({ data: active });
      const sessionID = prompt.pathname.split('/')[3];
      runningLooks += 1;
      return json({ data: hangWait || runningLooks <= 1 ? { [sessionID]: { type: 'running' } } : {} });
    }
    if (method === 'GET' && pathname === '/api/session') return json({ data: [] });
    if (method === 'POST' && pathname === '/api/session') return json({ data: { id: 'ses_dream' } });
    if (method === 'POST' && pathname.endsWith('/stop')) return json({ data: { matched: 0, terminated: 0, failed: 0 } });
    if (method === 'POST' && pathname.endsWith('/prompt')) {
      await onPrompt(body);
      return json({ data: {} });
    }
    if (method === 'POST' && pathname.endsWith('/wait')) {
      if (hangWait) {
        await new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
      }
      return json({ data: {} });
    }
    if (method === 'GET' && pathname.endsWith('/message')) {
      return json({ data: [{ type: 'assistant', content: [{ type: 'text', text: reply }] }] });
    }
    return json({});
  };
  return { calls, fetchImpl };
};

const createDreaming = ({ openCode, settings = {}, clock = { now: Date.now() }, hiddenSessions = createHiddenSessionRegistry(), passTimeoutMs } = {}) => createMemoryDreaming({
  agentMemoryRuntime: memory,
  readSettings: async () => ({
    agentMemoryToolEnabled: true,
    agentMemoryDreamingEnabled: true,
    projects: [{ id: 'acme', path: PROJECT_DIR }],
    ...settings,
  }),
  resolveProjectId: async () => PROJECT_ID,
  measureIndex: () => ({ budget: 8000, used: 100, omitted: 0 }),
  hiddenSessions,
  createSessionId: () => 'ses_dream',
  buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
  getOpenCodeAuthHeaders: () => ({}),
  resolveSessionDefaults: () => ({ providerID: 'zai', modelID: 'glm', variant: null, agent: null }),
  fetchImpl: openCode.fetchImpl,
  now: () => clock.now,
  setTimer: (callback, ms) => setTimeout(callback, Math.min(ms, passTimeoutMs ?? ms)),
  passTimeoutMs,
  pollIntervalMs: 1,
  log: () => {},
});

describe('when a pass runs', () => {
  test('does nothing while dreaming is off', async () => {
    await fill(12);
    const openCode = createOpenCode();
    await createDreaming({ openCode, settings: { agentMemoryDreamingEnabled: false } }).check();
    // Only the look for sessions an earlier server left behind.
    expect(openCode.calls.map((call) => `${call.method} ${call.pathname}`)).toEqual(['GET /api/session']);
  });

  test('waits while a session is running', async () => {
    await fill(12);
    const openCode = createOpenCode({ active: { ses_user: { type: 'busy' } } });
    await createDreaming({ openCode }).check();
    expect(openCode.calls.some((call) => call.method === 'POST' && call.pathname === '/api/session')).toBe(false);
  });

  test('skips a store with too few changes', async () => {
    await fill(3);
    const openCode = createOpenCode();
    await createDreaming({ openCode }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(false);
  });

  test('runs again only a day after the last pass', async () => {
    await fill(12);
    const clock = { now: Date.now() };
    await memory.recordDream(PROJECT, { lastRunAt: clock.now - DAY / 2, record: { finishedAt: clock.now - DAY / 2 }, snapshot: null });
    const openCode = createOpenCode();
    await createDreaming({ openCode, clock }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(false);

    clock.now += DAY;
    await createDreaming({ openCode, clock }).check();
    expect(openCode.calls.some((call) => call.pathname === '/api/session' && call.method === 'POST')).toBe(true);
  });
});

describe('a pass', () => {
  for (const retry of ['check', 'shutdown']) test(`retries a failed stop for its owned hidden session on ${retry}`, async () => {
    await fill(12);
    const openCode = createOpenCode();
    const original = openCode.fetchImpl;
    let stops = 0;
    const cleanup = [];
    openCode.fetchImpl = async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('/stop')) {
        cleanup.push(`stop ${pathname}`);
        return Response.json({ data: { matched: 1, terminated: stops++ ? 1 : 0, failed: stops === 1 ? 1 : 0 } });
      }
      if (init.method === 'DELETE') cleanup.push(`delete ${pathname}`);
      return original(url, init);
    };
    const runtime = createDreaming({ openCode });
    await runtime.check();
    expect(cleanup).toEqual(['stop /api/session/ses_dream/stop']);
    if (retry === 'check') await runtime.check();
    else await runtime.stop({ deadline: Date.now() + 5000 });
    expect(cleanup).toEqual(['stop /api/session/ses_dream/stop', 'stop /api/session/ses_dream/stop', 'delete /api/session/ses_dream']);
  });

  for (const phase of ['create', 'prompt', 'poll', 'delete']) {
    test(`shutdown joins a pass during ${phase} and cleans only its owned session`, async () => {
      await fill(12);
      const openCode = createOpenCode();
      const original = openCode.fetchImpl;
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      let prompted = false;
      let held = false;
      const paths = [];
      openCode.fetchImpl = async (url, init = {}) => {
        const pathname = new URL(url).pathname;
        paths.push(`${init.method} ${pathname}`);
        if (pathname.endsWith('/prompt')) prompted = true;
        const current = init.method === 'DELETE' ? 'delete'
          : pathname.endsWith('/prompt') ? 'prompt'
          : init.method === 'POST' && pathname === '/api/session' ? 'create'
          : prompted && pathname === '/api/session/active' ? 'poll' : null;
        if (current === phase && !held) { held = true; entered.resolve(); await release.promise; }
        if (pathname.endsWith('/stop')) return Response.json({ data: { matched: 0, terminated: 0, failed: 0 } });
        return original(url, init);
      };
      const runtime = createDreaming({ openCode });
      const checking = runtime.check();
      await entered.promise;
      let stopped = false;
      const stopping = Promise.resolve(runtime.stop({ deadline: Date.now() + 5000 })).then(() => { stopped = true; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(stopped).toBe(false);
      } finally {
        release.resolve();
        await Promise.all([checking, stopping]);
      }
      if (phase === 'create') expect(paths.some((value) => value.endsWith('/prompt'))).toBe(false);
      expect(paths.filter((value) => value.endsWith('/stop'))).toEqual(['POST /api/session/ses_dream/stop']);
      expect(paths.filter((value) => value.startsWith('DELETE'))).toEqual(['DELETE /api/session/ses_dream']);
      expect((await memory.readDreamState(PROJECT)).record).not.toBeNull();
      const count = paths.length;
      runtime.start();
      await runtime.check();
      expect(paths).toHaveLength(count);
    });
  }

  test('runs hidden, records what changed and removes its session', async () => {
    await fill(12);
    const hiddenSessions = createHiddenSessionRegistry();
    let hiddenDuringRun = false;
    const openCode = createOpenCode({
      onPrompt: async () => {
        // The agent folds Fact 0 into Fact 1, drops Fact 2, rewrites Fact 3.
        const entries = (await memory.read(PROJECT)).entries;
        const byTitle = (title) => entries.find((entry) => entry.title === title);
        hiddenDuringRun = hiddenSessions.has('ses_dream');
        await memory.update(PROJECT, byTitle('Fact 1').id, { body: 'Facts 0 and 1 together.' });
        await memory.remove(PROJECT, byTitle('Fact 0').id);
        await memory.remove(PROJECT, byTitle('Fact 2').id);
        await memory.update(PROJECT, byTitle('Fact 3').id, { body: 'True now.' });
      },
    });
    await createDreaming({ openCode, hiddenSessions }).check();

    const create = openCode.calls.find((call) => call.method === 'POST' && call.pathname === '/api/session');
    expect(create.body.metadata).toEqual({ hidden: true, openchamber: { kind: 'memory-dream' } });
    expect(create.body.model).toEqual({ providerID: 'zai', id: 'glm' });
    expect(create.body.permissions[0]).toEqual({ action: '*', resource: '*', effect: 'deny' });
    expect(create.body.permissions).toContainEqual({ action: 'execute', resource: '*', effect: 'allow' });
    expect(hiddenDuringRun).toBe(true);
    // Still hidden after the pass: events that trail the delete stay unseen.
    expect(hiddenSessions.has('ses_dream')).toBe(true);
    expect(openCode.calls.some((call) => call.method === 'DELETE' && call.pathname === '/api/session/ses_dream')).toBe(true);

    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'done', merged: 1, removed: 1, rewritten: 2 });
    // Fact 2 (mem-3) was deleted by the pass, so only the entry still there is offered for the docs.
    expect(state.record.toDocs).toEqual(['mem-6']);
    expect(state.snapshot).toHaveLength(12);
  });

  test('uses the model chosen for dreaming', async () => {
    await fill(12);
    const openCode = createOpenCode();
    await createDreaming({ openCode, settings: { agentMemoryDreamingModel: 'openai/gpt-mini', agentMemoryDreamingVariant: 'low' } }).check();
    const create = openCode.calls.find((call) => call.method === 'POST' && call.pathname === '/api/session');
    expect(create.body.model).toEqual({ providerID: 'openai', id: 'gpt-mini', variant: 'low' });
  });

  test('a pass that does not finish in time is stopped and recorded as failed', async () => {
    await fill(12);
    const openCode = createOpenCode({ hangWait: true, onPrompt: async () => {
      const entries = (await memory.read(PROJECT)).entries;
      await memory.remove(PROJECT, entries[0].id);
    } });
    await createDreaming({ openCode, passTimeoutMs: 20 }).check();

    expect(openCode.calls.some((call) => call.pathname.endsWith('/stop'))).toBe(true);
    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'failed', error: 'The pass did not finish in time', removed: 1 });
    // What it changed before stopping can still be undone.
    expect(state.snapshot).toHaveLength(12);
  });
});

describe('a failed turn', () => {
  test('a provider error is recorded as a failure, not as nothing to tidy', async () => {
    await fill(12);
    const openCode = createOpenCode();
    const fetchImpl = openCode.fetchImpl;
    openCode.fetchImpl = async (url, init = {}) => {
      if (new URL(url).pathname.endsWith('/message')) {
        return new Response(JSON.stringify({ data: [
          { type: 'idle', outcome: 'failed', error: { message: 'Free usage limit reached.' } },
          { type: 'assistant', finish: 'error', content: [] },
        ] }), { status: 200 });
      }
      return fetchImpl(url, init);
    };
    await createDreaming({ openCode }).check();
    const state = await memory.readDreamState(PROJECT);
    expect(state.record).toMatchObject({ status: 'failed', error: 'Free usage limit reached.' });
    expect(state.snapshot).toBeNull();
  });
});

describe('pieces', () => {
  test('diffDream counts deleted and rewritten entries', () => {
    const before = [{ id: 'a', title: 'A', body: 'x', type: 'fact' }, { id: 'b', title: 'B', body: 'y', type: 'fact' }, { id: 'c', title: 'C', body: 'z', type: 'fact' }];
    const after = [{ id: 'a', title: 'A', body: 'x', type: 'fact' }, { id: 'b', title: 'B', body: 'changed', type: 'fact' }];
    expect(diffDream(before, after)).toEqual({ deleted: 1, rewritten: 1 });
  });

  test('the prompt names the overflow and carries every entry with its id', () => {
    const prompt = buildDreamPrompt({
      directory: PROJECT_DIR,
      project: [{ id: 'mem-1', type: 'fact', title: 'Uses bun', body: 'Tests run with bun.', updatedAt: 0 }],
      global: null,
      index: { budget: 8000, used: 9000, omitted: 12 },
    });
    expect(prompt).toContain('"memoryId":"mem-1"');
    expect(prompt).toContain('12 titles do not fit now');
    expect(prompt).not.toContain('The user\'s memory (scope "global")');
    expect(prompt).toContain('belong in the project\'s agent docs');
  });
});
