import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FINAL_MARKER_CLEAN,
  FINAL_MARKER_DISPUTED,
  LOOP_RULES,
  MAX_ROUNDS,
  createAutoReviewRuntime,
  readDisputeSummary,
  readReviewVerdict,
} from './runtime.js';

const ORIGINAL = 'ses_original';
const REVIEW = 'ses_review';
const DIRECTORY = '/repo';

const temporaryDirectories = [];
const runtimes = [];

afterEach(async () => {
  const stopping = runtimes.splice(0);
  for (const runtime of stopping) runtime.stop();
  await Promise.all(stopping.map((runtime) => runtime.flush()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const makeDataDir = async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-auto-review-'));
  temporaryDirectories.push(directory);
  return directory;
};

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A stand-in for the OpenCode routes the runtime uses. A prompt admitted to a
 * session runs a turn at once when a reply is scripted for it: the reply and
 * the run's `idle` record are appended, as OpenCode does when a run ends.
 * Records are kept oldest first and served newest first.
 */
const createOpenCode = () => {
  const state = {
    active: {},
    records: { [ORIGINAL]: [], [REVIEW]: [] },
    // Scripted turns per session: a reply text, or `{ outcome, text?, error? }`.
    replies: { [ORIGINAL]: [], [REVIEW]: [] },
    prompts: [],
    synthetic: [],
    seenIds: new Set(),
    failPrompts: 0,
    closed: [],
    stops: [],
    stopFailures: {},
    counter: 0,
  };
  const runTurn = (sessionID) => {
    const scripted = state.replies[sessionID].shift();
    if (scripted === undefined) return;
    const turn = typeof scripted === 'string' ? { outcome: 'succeeded', text: scripted } : scripted;
    state.counter += 1;
    const created = state.counter;
    if (turn.text !== undefined || turn.error) {
      const reply = {
        type: 'assistant',
        id: `msg_reply${created}`,
        content: turn.text ? [{ type: 'text', text: turn.text }] : [],
        time: { created, completed: created },
      };
      if (turn.error) reply.error = { message: turn.error };
      state.records[sessionID].push(reply);
    }
    state.records[sessionID].push({ type: 'idle', id: `msg_idle${created}`, outcome: turn.outcome, time: { created } });
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (pathname === '/api/session/active') return json({ data: state.active });
    if (pathname === '/api/session' && method === 'GET') return json({ data: [], cursor: {} });
    const close = pathname.match(/^\/api\/session\/([^/]+)\/inbox\/([^/]+)\/close$/);
    if (close) {
      state.closed.push({ sessionID: close[1], messageID: close[2] });
      return json({ data: { state: 'closed' } });
    }
    const stop = pathname.match(/^\/api\/session\/([^/]+)\/stop$/);
    if (stop) {
      state.stops.push(stop[1]);
      return json({ matched: 1, terminated: 1, failed: state.stopFailures[stop[1]] ?? 0 });
    }
    const match = pathname.match(/^\/api\/session\/([^/]+)\/(message|prompt|synthetic)$/);
    if (!match) return json({ error: 'not found' }, 404);
    const sessionID = decodeURIComponent(match[1]);
    if (!state.records[sessionID]) return json({ error: 'not found' }, 404);
    if (match[2] === 'message') return json({ data: [...state.records[sessionID]].reverse(), cursor: {} });
    const body = JSON.parse(init.body);
    if (match[2] === 'prompt' && state.failPrompts > 0) {
      state.failPrompts -= 1;
      return json({ error: 'boom' }, 500);
    }
    if (state.seenIds.has(body.id)) return json({ data: { id: body.id } });
    state.seenIds.add(body.id);
    if (match[2] === 'synthetic') {
      state.synthetic.push({ sessionID, ...body });
      state.records[sessionID].push({ type: 'synthetic', id: body.id, text: body.text });
      return json({ data: { id: body.id } });
    }
    state.prompts.push({ sessionID, ...body });
    state.records[sessionID].push({ type: 'user', id: body.id, text: body.text });
    runTurn(sessionID);
    return json({ data: { id: body.id } });
  });
  return { state, fetchImpl };
};

const createRuntime = async ({ dataDir, openCode = createOpenCode(), retryDelayMs = () => 5, routeSend = null } = {}) => {
  let eventHandler = () => {};
  const broadcasts = [];
  const settled = [];
  const ended = [];
  const runtime = createAutoReviewRuntime({
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus() { return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    broadcastUiEvent: (event) => broadcasts.push(event),
    onRunSettled: (sessionID) => settled.push(sessionID),
    onRunEnded: (run) => ended.push(run),
    routeSend,
    dataDir: dataDir ?? await makeDataDir(),
    fetchImpl: openCode.fetchImpl,
    quietMs: 0,
    retryDelayMs,
    subagentRecheckMs: 5,
    settleRecheckMs: 5,
  });
  runtimes.push(runtime);
  return {
    runtime,
    openCode,
    broadcasts,
    settled,
    ended,
    emit: (payload) => eventHandler({ payload, translated: () => [payload] }),
  };
};

const prompts = {
  reviewStart: 'Review this.\n\n{{handoff}}',
  reviewRules: 'Review rules.',
  feedbackToImplementer: 'Feedback:\n{{review_feedback}}',
  responseToReviewer: 'Response:\n{{implementation_response}}',
};

const startInput = (extra = {}) => ({
  originalSessionID: ORIGINAL,
  reviewSessionID: REVIEW,
  directory: DIRECTORY,
  handoff: { text: 'Write a handoff.', instructions: 'Handoff rules.' },
  prompts,
  ...extra,
});

const until = async (check, timeoutMs = 2_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
};

const runOf = (runtime) => runtime.snapshot().runs.find((run) => run.originalSessionID === ORIGINAL) ?? null;

describe('readReviewVerdict', () => {
  it('reads the final line and leaves it out of the feedback', () => {
    expect(readReviewVerdict(`Nit: rename x.\n${FINAL_MARKER_CLEAN}\n\n`)).toEqual({ kind: 'clean', feedback: 'Nit: rename x.' });
    expect(readReviewVerdict(`Still disagree on 2.\n${FINAL_MARKER_DISPUTED.toUpperCase()}`)).toEqual({ kind: 'disputed', feedback: 'Still disagree on 2.' });
    expect(readReviewVerdict(`1. Blocker.\n${FINAL_MARKER_CLEAN} because`)).toEqual({ kind: 'open', feedback: `1. Blocker.\n${FINAL_MARKER_CLEAN} because` });
  });
});

describe('readDisputeSummary', () => {
  it('takes what follows the last heading, else the whole review cut short', () => {
    expect(readDisputeSummary('Intro.\n## Disputed findings: 3 is wrong\nbecause X')).toBe('3 is wrong\nbecause X');
    expect(readDisputeSummary('No heading here.')).toBe('No heading here.');
    expect(readDisputeSummary('x'.repeat(3_000))).toHaveLength(2_000);
  });
});

describe('createAutoReviewRuntime', () => {
  it('carries a handoff, the review, the fixes and the re-review until nothing is left', async () => {
    const { runtime, openCode, settled, ended } = await createRuntime();
    openCode.state.replies[ORIGINAL].push('The handoff.', 'Fixed the blocker.');
    openCode.state.replies[REVIEW].push('1. Blocker: X breaks.', `Nit: a name.\n${FINAL_MARKER_CLEAN}`);
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'clean')).toBe(true);
    expect(openCode.state.prompts.map((prompt) => [prompt.sessionID, prompt.text])).toEqual([
      [ORIGINAL, 'Write a handoff.'],
      [REVIEW, 'Review this.\n\nThe handoff.'],
      [ORIGINAL, 'Feedback:\n1. Blocker: X breaks.'],
      [REVIEW, 'Response:\nFixed the blocker.'],
      [ORIGINAL, 'Feedback:\nNit: a name.'],
    ]);
    expect(openCode.state.prompts.map((item) => item.context)).toEqual([
      [{ text: 'Handoff rules.' }],
      [{ text: 'Review rules.' }, { text: LOOP_RULES }],
      [],
      [{ text: LOOP_RULES }],
      [],
    ]);
    // There are no independently admitted context messages to orphan on Stop.
    expect(openCode.state.synthetic).toEqual([]);
    expect(runOf(runtime)).toMatchObject({ status: 'clean', round: 1, maxRounds: MAX_ROUNDS });
    // The queue is released once the settled run is on disk.
    expect(await until(() => settled.length > 0)).toBe(true);
    expect(settled).toEqual([ORIGINAL]);
    // One notification for the whole review, and its steps are its own.
    expect(await until(() => ended.length > 0)).toBe(true);
    expect(ended).toEqual([{ sessionId: ORIGINAL, directory: DIRECTORY, status: 'clean', error: undefined }]);
    // The last step ended before the run settled; a turn after it is the user's.
    const settledAt = runOf(runtime).updatedAt;
    expect(runtime.speaksFor(ORIGINAL, settledAt - 1)).toBe(true);
    expect(runtime.speaksFor(REVIEW, settledAt - 1)).toBe(true);
    expect(runtime.speaksFor(ORIGINAL, settledAt + 1)).toBe(false);
    expect(runtime.speaksFor('ses_someone_else', settledAt - 1)).toBe(false);
  });

  it('settles as disputed and sends nothing more when only contested declines are left', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[REVIEW].push(`Finding 1 is fixed.\n\n**Disputed findings:**\n2. Implementer: the guard is dead code.\nMine: it runs on Windows.\n${FINAL_MARKER_DISPUTED}`);
    runtime.start();
    await runtime.startRun(startInput({ handoff: undefined, prompts: { ...prompts, reviewStart: 'Review the diff.' } }));

    expect(await until(() => runOf(runtime)?.status === 'disputed')).toBe(true);
    expect(openCode.state.prompts.map((prompt) => prompt.sessionID)).toEqual([REVIEW]);
    // The row unfolds what the two sides disagree on, not the whole review.
    expect(runOf(runtime).dispute).toBe('2. Implementer: the guard is dead code.\nMine: it runs on Windows.');
  });

  it('stops at the round limit with its own status', async () => {
    const { runtime, openCode } = await createRuntime();
    for (let round = 0; round <= MAX_ROUNDS; round += 1) {
      openCode.state.replies[REVIEW].push(`Round ${round}: still open.`);
      openCode.state.replies[ORIGINAL].push(`Round ${round}: fixed.`);
    }
    runtime.start();
    await runtime.startRun(startInput({ handoff: undefined }));

    expect(await until(() => runOf(runtime)?.status === 'limit', 5_000)).toBe(true);
    expect(runOf(runtime).round).toBe(MAX_ROUNDS);
    expect(openCode.state.prompts.filter((prompt) => prompt.sessionID === REVIEW)).toHaveLength(MAX_ROUNDS + 1);
  });

  it('waits for a running session before it sends, so nothing steers into a live turn', async () => {
    const { runtime, openCode, emit } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(openCode.state.prompts).toEqual([]);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: ORIGINAL, status: { type: 'idle' } } });
    expect(await until(() => openCode.state.prompts.length === 1)).toBe(true);
  });

  it('stops the run when the user stops the turn it waits on, and says so without notifying', async () => {
    const { runtime, openCode, settled, ended } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'interrupted', text: 'Half a handoff' });
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'stopped')).toBe(true);
    expect(await until(() => settled.length > 0)).toBe(true);
    expect(settled).toEqual([ORIGINAL]);
    expect(openCode.state.prompts).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ended).toEqual([]);
  });

  it('reports a failed turn with its error', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'failed', error: 'rate limited' });
    runtime.start();
    await runtime.startRun(startInput());

    expect(await until(() => runOf(runtime)?.status === 'failed')).toBe(true);
    expect(runOf(runtime).error).toBe("The implementer's turn failed: rate limited");
  });

  it('retries a failed send with the same ids and never admits a record twice, across a restart', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.failPrompts = 1;
    // The first server retries only long after it is gone.
    const first = await createRuntime({ dataDir, openCode, retryDelayMs: () => 60_000 });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    expect(await until(() => openCode.fetchImpl.mock.calls.some(([url]) => String(url).endsWith('/prompt')))).toBe(true);
    expect(openCode.state.prompts).toEqual([]);
    first.runtime.stop();
    await first.runtime.flush();

    openCode.state.replies[ORIGINAL].push('The handoff.');
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(openCode.state.prompts.map((prompt) => prompt.text)).toEqual(['Write a handoff.', 'Review this.\n\nThe handoff.']);
    expect(openCode.state.prompts.filter((item) => item.context.some((entry) => entry.text === 'Handoff rules.'))).toHaveLength(1);
  });

  it('routes a session on Auto before each prompt, and a routing failure sends nothing', async () => {
    const routed = [];
    let failRouting = true;
    const routeSend = async (send) => {
      if (failRouting) throw new Error('no fallback model');
      routed.push(send);
    };
    const { runtime, openCode } = await createRuntime({ routeSend, retryDelayMs: () => 20 });
    openCode.state.replies[ORIGINAL].push('The handoff.');
    runtime.start();
    await runtime.startRun(startInput());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(openCode.state.prompts).toEqual([]);
    expect(openCode.state.synthetic).toEqual([]);

    failRouting = false;
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(routed).toEqual([
      { sessionId: ORIGINAL, directory: DIRECTORY, text: 'Write a handoff.' },
      { sessionId: REVIEW, directory: DIRECTORY, text: 'Review this.\n\nThe handoff.' },
    ]);
  });

  it('holds the queue until its runs are loaded after a start', async () => {
    const { runtime } = await createRuntime();
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
    runtime.start();
    await runtime.startupLoad;
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(false);
  });

  it('keeps a reply of any length across a restart', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.replies[ORIGINAL].push('h'.repeat(150_000));
    // The reviewer is busy, so the long review prompt waits on disk.
    openCode.state.active = { [REVIEW]: { type: 'running' } };
    const first = await createRuntime({ dataDir, openCode });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    expect(await until(() => runOf(first.runtime)?.step === 'review')).toBe(true);
    first.runtime.stop();
    await first.runtime.flush();

    openCode.state.active = {};
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    expect(await until(() => openCode.state.prompts.length === 2)).toBe(true);
    expect(openCode.state.prompts[1].text).toHaveLength('Review this.\n\n'.length + 150_000);
  });

  it('cuts a long failure to one line for the row', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[ORIGINAL].push({ outcome: 'failed', error: 'e'.repeat(3_000) });
    runtime.start();
    await runtime.startRun(startInput());
    expect(await until(() => runOf(runtime)?.status === 'failed')).toBe(true);
    expect(runOf(runtime).error.length).toBe(500);
  });

  it('refuses a second running review of the same session and a session reviewing itself', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    await expect(runtime.startRun(startInput())).rejects.toMatchObject({ status: 409 });
    await expect(runtime.startRun(startInput({ reviewSessionID: ORIGINAL }))).rejects.toBeInstanceOf(TypeError);
  });

  it('stops a running review on request, releases the queue and tells the clients', async () => {
    const { runtime, openCode, broadcasts, settled } = await createRuntime();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    runtime.start();
    await runtime.startRun(startInput());
    expect(runtime.isRunning(ORIGINAL)).toBe(true);

    await runtime.removeRun(ORIGINAL);
    expect(openCode.state.stops).toEqual([ORIGINAL, REVIEW]);
    expect(runtime.isRunning(ORIGINAL)).toBe(false);
    expect(runtime.snapshot().runs).toEqual([]);
    expect(await until(() => settled.length === 1)).toBe(true);
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:auto-review.updated',
      properties: { originalSessionID: ORIGINAL, directory: DIRECTORY, run: null },
    });
  });

  it('retains a failed Stop and its queue hold across a restart, then retries both sessions', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    openCode.state.stopFailures[REVIEW] = 1;
    const first = await createRuntime({ dataDir, openCode });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    await expect(first.runtime.removeRun(ORIGINAL)).rejects.toThrow();
    expect(runOf(first.runtime)?.status).toBe('stop_failed');
    expect(first.runtime.holdsDelivery(ORIGINAL)).toBe(true);
    expect(first.settled).toEqual([]);
    await expect(first.runtime.startRun(startInput())).rejects.toMatchObject({ status: 409 });
    first.runtime.stop();
    await first.runtime.flush();

    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    await second.runtime.startupLoad;
    expect(second.runtime.holdsDelivery(ORIGINAL)).toBe(true);
    expect(runOf(second.runtime)?.status).toBe('stop_failed');
    openCode.state.stopFailures[REVIEW] = 0;
    await second.runtime.removeRun(ORIGINAL);
    expect(openCode.state.stops).toEqual([ORIGINAL, REVIEW, ORIGINAL, REVIEW]);
    expect(second.runtime.holdsDelivery(ORIGINAL)).toBe(false);
    expect(second.settled).toEqual([ORIGINAL]);
  });

  it('keeps malformed bytes and holds all queue auto-delivery until a successful reread', async () => {
    const dataDir = await makeDataDir();
    const file = path.join(dataDir, 'auto-review.json');
    await fs.writeFile(file, '{broken');
    const { runtime } = await createRuntime({ dataDir });
    runtime.start();
    await expect(runtime.load()).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    expect(runtime.holdsDelivery('ses_unrelated')).toBe(true);
    await fs.writeFile(file, JSON.stringify({ version: 2, runs: [] }));
    await runtime.load();
    await runtime.startupLoad;
    expect(runtime.holdsDelivery('ses_unrelated')).toBe(false);
  });

  it('waits for an in-flight send, closes only persisted review IDs, then stops and releases once', async () => {
    let enterSend;
    const entered = new Promise((resolve) => { enterSend = resolve; });
    let finishSend;
    const sending = new Promise((resolve) => { finishSend = resolve; });
    const openCode = createOpenCode();
    const actual = openCode.fetchImpl.getMockImplementation();
    openCode.fetchImpl.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/prompt')) {
        enterSend();
        await sending;
      }
      return actual(url, init);
    });
    const dataDir = await makeDataDir();
    const { runtime, settled } = await createRuntime({ dataDir, openCode });
    runtime.start();
    await runtime.startRun(startInput());
    await entered;
    const firstStop = runtime.removeRun(ORIGINAL);
    const secondStop = runtime.removeRun(ORIGINAL);
    expect(await until(() => runOf(runtime)?.status === 'stopping')).toBe(true);
    expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
    expect(openCode.state.stops).toEqual([]);
    expect(openCode.state.closed).toEqual([]);
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'auto-review.json'), 'utf8'));
    const owned = stored.runs[0].ownedMessages;
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ sessionID: ORIGINAL });
    finishSend();
    await Promise.all([firstStop, secondStop]);
    expect(openCode.state.closed).toEqual(owned);
    expect(openCode.state.stops).toEqual([ORIGINAL, REVIEW]);
    expect(openCode.state.prompts).toHaveLength(1);
    expect(settled).toEqual([ORIGINAL]);
    const methods = openCode.fetchImpl.mock.calls.map(([url]) => new URL(url).pathname.split('/').at(-1));
    expect(methods.lastIndexOf('prompt')).toBeLessThan(methods.indexOf('close'));
    expect(methods.indexOf('close')).toBeLessThan(methods.indexOf('stop'));
  });

  it('prevents a send paused in routing from admitting after Stop', async () => {
    let finishRouting;
    const routing = new Promise((resolve) => { finishRouting = resolve; });
    let entered;
    const routed = new Promise((resolve) => { entered = resolve; });
    const { runtime, openCode } = await createRuntime({ routeSend: () => { entered(); return routing; } });
    runtime.start();
    await runtime.startRun(startInput());
    await routed;
    const stopping = runtime.removeRun(ORIGINAL);
    expect(await until(() => runOf(runtime)?.status === 'stopping')).toBe(true);
    finishRouting();
    await stopping;
    expect(openCode.state.prompts).toEqual([]);
    expect(openCode.state.closed).toHaveLength(1);
  });

  it('keeps ownership after awaiting a reply and restarting, and treats closure uncertainty as a failed Stop', async () => {
    const dataDir = await makeDataDir();
    const openCode = createOpenCode();
    const first = await createRuntime({ dataDir, openCode });
    first.runtime.start();
    await first.runtime.startRun(startInput());
    expect(await until(() => openCode.state.prompts.length === 1)).toBe(true);
    first.runtime.stop();
    await first.runtime.flush();
    const originalFetch = openCode.fetchImpl.getMockImplementation();
    openCode.fetchImpl.mockImplementation((url, init) => String(url).endsWith('/close')
      ? Promise.reject(new Error('lost response')) : originalFetch(url, init));
    const second = await createRuntime({ dataDir, openCode });
    second.runtime.start();
    await second.runtime.startupLoad;
    await expect(second.runtime.removeRun(ORIGINAL)).rejects.toThrow('lost response');
    expect(openCode.state.stops).toEqual([ORIGINAL, REVIEW]);
    expect(second.runtime.holdsDelivery(ORIGINAL)).toBe(true);
    expect(second.settled).toEqual([]);
    openCode.fetchImpl.mockImplementation(originalFetch);
    await second.runtime.removeRun(ORIGINAL);
    expect(openCode.state.closed).toEqual([{ sessionID: ORIGINAL, messageID: openCode.state.prompts[0].id }]);
    expect(second.settled).toEqual([ORIGINAL]);
  });

  it('dismisses a finished result without stopping either session', async () => {
    const { runtime, openCode } = await createRuntime();
    openCode.state.replies[REVIEW].push(FINAL_MARKER_CLEAN);
    runtime.start();
    await runtime.startRun(startInput({ handoff: undefined }));
    expect(await until(() => runOf(runtime)?.status === 'clean')).toBe(true);
    await runtime.removeRun(ORIGINAL);
    expect(openCode.state.closed).toEqual([]);
    expect(openCode.state.stops).toEqual([]);
    expect(runtime.snapshot().runs).toEqual([]);
  });

  it('offers retry for a Stop interrupted by a restart instead of restoring a disabled stopping row', async () => {
    const dataDir = await makeDataDir();
    const first = await createRuntime({ dataDir });
    first.openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    await first.runtime.startRun(startInput());
    first.runtime.stop();
    await first.runtime.flush();
    const file = path.join(dataDir, 'auto-review.json');
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    stored.runs[0].status = 'stopping';
    await fs.writeFile(file, JSON.stringify(stored));
    const second = await createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.startupLoad;
    expect(runOf(second.runtime)).toMatchObject({ status: 'stop_failed', error: expect.stringContaining('Retry Stop') });
    expect(second.runtime.holdsDelivery(ORIGINAL)).toBe(true);
    await second.runtime.removeRun(ORIGINAL);
    expect(second.openCode.state.stops).toEqual([ORIGINAL, REVIEW]);
  });

  it.each([false, true])('holds delivery throughout the final Stop write (write fails=%s)', async (failWrite) => {
    const dataDir = await makeDataDir();
    const file = path.join(dataDir, 'auto-review.json');
    const { runtime, openCode, settled } = await createRuntime({ dataDir });
    openCode.state.active = { [ORIGINAL]: { type: 'running' } };
    await runtime.startRun(startInput());
    const rename = fs.rename;
    let enterWrite;
    const entered = new Promise((resolve) => { enterWrite = resolve; });
    let finishWrite;
    const gate = new Promise((resolve) => { finishWrite = resolve; });
    let paused = false;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === file && !paused && JSON.parse(await fs.readFile(from, 'utf8')).runs.length === 0) {
        paused = true;
        enterWrite();
        await gate;
        if (failWrite) throw new Error('disk unavailable');
      }
      return rename(from, to);
    });
    try {
      const stopping = runtime.removeRun(ORIGINAL);
      await entered;
      // This is the queue tick's admission gate, including idle-event ticks.
      expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
      expect(settled).toEqual([]);
      finishWrite();
      if (failWrite) {
        await expect(stopping).rejects.toThrow('disk unavailable');
        expect(runtime.holdsDelivery(ORIGINAL)).toBe(true);
        expect(runOf(runtime)?.status).toBe('stop_failed');
        expect(settled).toEqual([]);
      } else {
        await stopping;
        expect(runtime.holdsDelivery(ORIGINAL)).toBe(false);
        expect(settled).toEqual([ORIGINAL]);
      }
    } finally {
      finishWrite();
      spy.mockRestore();
    }
  });
});
