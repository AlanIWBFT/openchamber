// Auto-review: a review session and the session it reviews talk to each other
// until the reviewer has nothing left, without the user carrying the messages.
//
// The loop lives here, in the web server, so a closed tab or a locked phone
// does not stop it halfway. The UI creates the review session and starts a
// run; from then on this runtime does every send: the handoff request, the
// reviewer's first prompt, the feedback to the implementer and the answer back.
//
// Each step sends one prompt and waits for the end of the turn it starts, read
// the way `../dispatch-results` reads it: the session is not running, none of
// its subagents runs, and OpenCode has appended a newer `idle` record than the
// one before the prompt. The reply is the turn's newest assistant record.
// Prompt ids are minted in OpenCode's format and saved before the first
// attempt, so a retry after a crash or a lost response never sends twice.

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { OpenCode } from '@opencode/client';
import { assertOpenCodeApiResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { createMessageId, readDispatchOutcome } from '../dispatch-results/runtime.js';

const FILE_NAME = 'auto-review.json';
const FILE_VERSION = 2;
const MAX_RUNS = 100;
// Re-reviews after the first. A loop that has not settled by then is going in
// circles, and more rounds mostly grow the change.
export const MAX_ROUNDS = 5;
// Idle events arrive in bursts around a turn boundary.
const QUIET_MS = 500;
const SUBAGENT_RECHECK_MS = 5_000;
// Idle, but the run's `idle` record is not there yet: a few short rechecks.
const SETTLE_RECHECK_MS = 2_000;
const SETTLE_RECHECKS = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A send that keeps failing is reported, so the user is not left waiting on
// a loop that no longer moves. Reads that fail stay unknown and retry.
const MAX_SEND_FAILURES = 5;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_PAGE_LIMIT = 50;
// What a client may hand in at start. The text a run builds from replies
// later (a handoff, a review) has no limit: the reply is what it is.
const PROMPT_CHAR_LIMIT = 100_000;
// A provider error can be a whole response body; the row shows one line.
const ERROR_CHAR_LIMIT = 500;
// The dispute the result row unfolds: both positions in a few lines each.
const DISPUTE_CHAR_LIMIT = 2_000;

export const FINAL_MARKER_CLEAN = 'FINAL_REVIEW_STATUS: no_remaining_findings';
export const FINAL_MARKER_DISPUTED = 'FINAL_REVIEW_STATUS: disputed';
const DISPUTE_HEADING = 'Disputed findings:';

/** Sent ahead of every reviewer prompt; the loop reads its final line. */
export const LOOP_RULES = `This review is part of an automatic review loop. End your response with one of these exact final lines when it applies:
${FINAL_MARKER_CLEAN}
when no blocker or non-blocker finding remains open. Nits never keep the loop going: list them if useful and still end with that line.
${FINAL_MARKER_DISPUTED}
when every finding still open is one the implementer declined, you already answered that decline once, and you still disagree. The user decides those, and reads only this part: just above that line, write a line "${DISPUTE_HEADING}" and then, for each such finding, the implementer's position and yours in two or three plain lines each.
While a blocker or non-blocker remains open for any other reason, leave the final line out.`;

// Boundary schemas: the only place raw JSON (the file, client bodies,
// OpenCode answers, hub events) is inspected.
const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{4,128}$/);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9]{8,64}$/);
const timeSchema = z.number().finite().nonnegative();
const promptSchema = z.string().max(PROMPT_CHAR_LIMIT);

const STATUSES = ['running', 'stopping', 'stop_failed', 'clean', 'disputed', 'limit', 'failed', 'stopped'];
const holdsQueue = (run) => run && ['running', 'stopping', 'stop_failed'].includes(run.status);
const STEPS = ['handoff', 'review', 'implement'];

const templatesSchema = z.object({
  reviewStart: promptSchema,
  reviewRules: promptSchema,
  feedbackToImplementer: promptSchema,
  responseToReviewer: promptSchema,
});

const startInputSchema = z.object({
  originalSessionID: sessionIdSchema,
  reviewSessionID: sessionIdSchema,
  directory: z.string().trim().min(1),
  // Present when the implementer writes a handoff first; `reviewStart` then
  // carries the `{{handoff}}` placeholder.
  handoff: z.object({ text: promptSchema.min(1), instructions: promptSchema }).optional(),
  prompts: templatesSchema,
});

const sendSchema = z.object({
  sessionID: sessionIdSchema,
  text: z.string(),
  context: z.array(z.string()),
  // Minted with the baseline before the first attempt.
  messageID: messageIdSchema.optional(),
  afterIdleID: z.string().min(1).nullable().optional(),
  // Delivered as the run's last word: the run settles without a reply.
  settle: z.literal('clean').optional(),
});

const runSchema = z.object({
  originalSessionID: sessionIdSchema,
  reviewSessionID: sessionIdSchema,
  directory: z.string().min(1),
  status: z.enum(STATUSES),
  step: z.enum(STEPS),
  round: z.number().int().nonnegative(),
  prompts: templatesSchema,
  send: sendSchema.nullable(),
  awaiting: z.object({ sessionID: sessionIdSchema, afterIdleID: z.string().min(1).nullable() }).nullable(),
  // Keep every attempted prompt, including ones whose HTTP response was lost.
  ownedMessages: z.array(z.object({ sessionID: sessionIdSchema, messageID: messageIdSchema })),
  error: z.string().optional(),
  dispute: z.string().optional(),
  startedAt: timeSchema,
  updatedAt: timeSchema,
});

const storedFileSchema = z.object({ version: z.literal(FILE_VERSION), revision: z.number().int().nonnegative().optional(), runs: z.array(runSchema) });
const closeResultSchema = z.object({ state: z.enum(['closed', 'cancelled', 'delivered']) });
const stopResultSchema = z.object({ matched: z.number().int().nonnegative(), terminated: z.number().int().nonnegative(), failed: z.number().int().nonnegative() });
const recordTypeSchema = z.object({ type: z.string(), id: z.string().optional() });
const messagePageSchema = z.object({ data: z.array(z.unknown()) });
const statusEventSchema = z.object({
  type: z.literal('session.status'),
  properties: z.object({ sessionID: z.string().min(1), status: z.object({ type: z.string().min(1) }) }),
});
const deletedEventSchema = z.object({
  type: z.literal('session.deleted'),
  properties: z.object({ sessionID: z.string().min(1) }),
});
const errorCodeSchema = z.object({ code: z.string() });

const parse = (schema, value) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const retryDelay = (failures) => Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

const httpError = (message, status) => Object.assign(new Error(message), { status });

/** One placeholder filled; the inserted text is never read for placeholders itself. */
const fill = (template, key, value) => template.replace(
  new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'),
  () => value,
);

/**
 * What the reviewer decided, read from its final line: `clean` (nothing open),
 * `disputed` (only declines it still disagrees with), or `open`. The marker
 * line is not part of the feedback the implementer gets.
 */
export const readReviewVerdict = (text) => {
  const lines = text.trimEnd().split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const last = lines.at(-1)?.trim().toLowerCase() ?? '';
  const kind = last === FINAL_MARKER_CLEAN.toLowerCase()
    ? 'clean'
    : last === FINAL_MARKER_DISPUTED.toLowerCase() ? 'disputed' : 'open';
  if (kind !== 'open') lines.pop();
  return { kind, feedback: lines.join('\n').trim() };
};

const cut = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/**
 * The part of a disputed review the user reads: what follows the reviewer's
 * last "Disputed findings:" line (markdown emphasis or a heading mark around
 * it allowed), else the whole review, cut for the result row.
 */
export const readDisputeSummary = (feedback) => {
  const heading = DISPUTE_HEADING.toLowerCase();
  const lines = feedback.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const bare = lines[index].replace(/[#*_`>]/g, '').trim();
    if (!bare.toLowerCase().startsWith(heading)) continue;
    const rest = [bare.slice(heading.length), ...lines.slice(index + 1)].join('\n').trim();
    if (rest) return cut(rest, DISPUTE_CHAR_LIMIT);
  }
  return cut(feedback, DISPUTE_CHAR_LIMIT);
};

/** What clients see: the run without the prompts it carries. */
const toPublicRun = (run) => {
  const publicRun = {
    originalSessionID: run.originalSessionID,
    reviewSessionID: run.reviewSessionID,
    directory: run.directory,
    status: run.status,
    step: run.step,
    round: run.round,
    maxRounds: MAX_ROUNDS,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
  };
  if (run.error) publicRun.error = run.error;
  if (run.dispute) publicRun.dispute = run.dispute;
  return publicRun;
};

export function createAutoReviewRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastUiEvent,
  // A run holds the reviewed session's message queue; settling releases it.
  onRunSettled,
  // Told when a run ends on its own (not `stopped`): the one notification
  // the review sends, in place of the "ready" of each step.
  onRunEnded = null,
  // Puts a session on Auto onto the model routing picks for this prompt, as
  // the proxy does for a UI send; this runtime posts to OpenCode directly.
  routeSend = null,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  quietMs = QUIET_MS,
  retryDelayMs = retryDelay,
  subagentRecheckMs = SUBAGENT_RECHECK_MS,
  settleRecheckMs = SETTLE_RECHECK_MS,
}) {
  const filePath = path.join(dataDir, FILE_NAME);

  /** originalSessionID → run */
  const runs = new Map();
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let stopped = false;
  // Only a successful load establishes which queues may deliver.
  let startupLoadSettled = false;
  let markStartupLoadSettled = () => {};
  const startupLoad = new Promise((resolve) => { markStartupLoadSettled = resolve; });

  // In memory only: a restart starts every running run from a fresh tick.
  const timers = new Map(); // originalSessionID → timeout
  const readFailures = new Map(); // originalSessionID → consecutive failed reads
  const sendFailures = new Map(); // originalSessionID → consecutive failed sends
  const settleChecks = new Map(); // originalSessionID → rechecks spent waiting for the idle record
  const ticking = new Map(); // originalSessionID → in-flight tick
  const stopping = new Map(); // originalSessionID → server-owned Stop

  // --- persistence ---------------------------------------------------------

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (parse(errorCodeSchema, error)?.code === 'ENOENT') return { runs: [], revision: 0 };
      throw error;
    }
    // Unknown ownership must not become a terminal row that releases a queue.
    const stored = storedFileSchema.parse(JSON.parse(raw));
    const identities = new Set();
    for (const run of stored.runs) {
      if (identities.has(run.originalSessionID)) throw new Error('Duplicate saved auto-review session');
      identities.add(run.originalSessionID);
      if (run.ownedMessages.some((message) => ![run.originalSessionID, run.reviewSessionID].includes(message.sessionID))) {
        throw new Error('Invalid saved auto-review message ownership');
      }
      if (run.send && ![run.originalSessionID, run.reviewSessionID].includes(run.send.sessionID)) throw new Error('Invalid saved auto-review send target');
      if (run.send?.messageID && !run.ownedMessages.some((message) => message.sessionID === run.send.sessionID && message.messageID === run.send.messageID)) {
        throw new Error('Missing saved auto-review prompt ownership');
      }
      if (run.awaiting && !run.ownedMessages.some((message) => message.sessionID === run.awaiting.sessionID)) {
        throw new Error('Missing saved auto-review turn ownership');
      }
      if (run.status === 'stopping') {
        run.status = 'stop_failed';
        run.error = 'Review stop was interrupted by a restart. Retry Stop to finish cleanup.';
      }
    }
    return { runs: stored.runs, revision: stored.revision ?? 0 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const run of stored.runs) if (!runs.has(run.originalSessionID)) runs.set(run.originalSessionID, run);
          revision = Math.max(revision, stored.revision);
          startupLoadSettled = true;
          markStartupLoadSettled();
          reconcileAll();
        })
        .catch((error) => {
          // A failed read must not pass for "no runs": the next write would
          // clobber the file, so writes wait for a load that succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify({ version: FILE_VERSION, revision, runs: Array.from(runs.values()) });
    const write = writePromise.then(async () => {
      await fs.promises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      // Prompts and handoffs are conversation content: readable by the owner only.
      await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
      await fs.promises.rename(tmpPath, filePath);
    });
    writePromise = write.catch((error) => {
      console.warn('[auto-review] failed to persist runs:', error?.message ?? error);
    });
    return write;
  };

  /** Every change a client can see: bump, persist, broadcast. */
  const commit = async (originalSessionID, directory) => {
    revision += 1;
    const run = runs.get(originalSessionID) ?? null;
    const event = {
      type: 'openchamber:auto-review.updated',
      properties: { revision, originalSessionID, directory, run: run ? toPublicRun(run) : null },
    };
    await persist();
    broadcastUiEvent?.(event);
  };

  const snapshot = () => ({ revision, runs: Array.from(runs.values(), toPublicRun) });

  const isRunning = (sessionID) => runs.get(sessionID)?.status === 'running';
  const isHeld = (sessionID) => Boolean(holdsQueue(runs.get(sessionID)));

  /**
   * Whether a turn of `sessionID` that ended at `turnEndedAt` is a step of a
   * run, either session of it: the run is running, or it settled after that
   * turn ended, since a run settles on the idle of its last step and may do
   * so before the notification asks. A turn that ends after the run settled
   * (a queued follow-up the end released) is the user's own.
   */
  const speaksFor = (sessionID, turnEndedAt) => {
    for (const run of runs.values()) {
      if (run.originalSessionID !== sessionID && run.reviewSessionID !== sessionID) continue;
      if (holdsQueue(run) || run.updatedAt >= turnEndedAt) return true;
    }
    return false;
  };

  // --- OpenCode access -----------------------------------------------------

  const openCodeRequest = async (fetchPath, { method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    // A 2xx app shell is a failed request, not an accepted prompt.
    assertOpenCodeApiResponse(response, `OpenCode ${method} ${fetchPath}`);
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  /**
   * Where a session stands: `running`, `subagents`, `idle` with its newest
   * records, `deleted`, or null when OpenCode could not be asked. Unknown is
   * never idle: a failed read retries instead of acting on a guess.
   */
  const readSession = async (sessionID) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    if (statuses[sessionID]) return { kind: 'running' };
    const subagentsWorking = await activityProbe.hasWorkingChildren(sessionID, statuses);
    if (subagentsWorking === null) return null;
    if (subagentsWorking) return { kind: 'subagents' };
    try {
      const page = parse(messagePageSchema, await openCodeRequest(`/api/session/${encodeURIComponent(sessionID)}/message`, {
        query: { limit: String(MESSAGE_PAGE_LIMIT), order: 'desc' },
      }));
      if (!page) return null;
      return { kind: 'idle', records: page.data };
    } catch (error) {
      if (error?.status === 404) return { kind: 'deleted' };
      return null;
    }
  };

  /** The newest end-of-run record, or null when the session has none yet. */
  const newestIdleID = (records) => {
    const idle = records.map((record) => parse(recordTypeSchema, record)).find((record) => record?.type === 'idle');
    return idle?.id ?? null;
  };

  // Resolve transport/auth at the operation boundary, never across backend restarts.
  const openCodeClient = () => OpenCode.make({
    baseUrl: buildOpenCodeUrl('', ''),
    headers: getOpenCodeAuthHeaders(),
    fetch: async (...args) => {
      const response = await fetchImpl(...args);
      if (response.ok) assertOpenCodeApiResponse(response);
      return response;
    },
  });
  const requestOptions = () => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const sessionGone = (error, sessionID) => error?._tag === 'SessionNotFoundError' && error.sessionID === sessionID;

  // --- loop ----------------------------------------------------------------

  const clearTimer = (originalSessionID) => {
    const existing = timers.get(originalSessionID);
    if (existing) {
      clearTimeout(existing);
      timers.delete(originalSessionID);
    }
  };

  const arm = (originalSessionID, delayMs = quietMs) => {
    if (stopped || !isRunning(originalSessionID)) return;
    clearTimer(originalSessionID);
    const timer = setTimeout(() => {
      timers.delete(originalSessionID);
      tick(originalSessionID).catch((error) => {
        console.warn('[auto-review] tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(originalSessionID, timer);
  };

  const forgetLoopState = (originalSessionID) => {
    clearTimer(originalSessionID);
    readFailures.delete(originalSessionID);
    sendFailures.delete(originalSessionID);
    settleChecks.delete(originalSessionID);
  };

  const settle = async (run, status, error) => {
    run.status = status;
    run.send = null;
    run.awaiting = null;
    if (error) run.error = cut(error, ERROR_CHAR_LIMIT);
    run.updatedAt = now();
    forgetLoopState(run.originalSessionID);
    await commit(run.originalSessionID, run.directory);
    if (runs.get(run.originalSessionID) !== run || run.status !== status) return;
    Promise.resolve().then(() => onRunSettled?.(run.originalSessionID)).catch(() => undefined);
    if (status !== 'stopped') {
      const ended = { sessionId: run.originalSessionID, directory: run.directory, status, error: run.error };
      Promise.resolve().then(() => onRunEnded?.(ended)).catch(() => undefined);
    }
    console.log(`[auto-review] review of ${run.originalSessionID} ended: ${status}${error ? ` (${error})` : ''}`);
  };

  /** The session that speaks next in this run: the one a send goes to, or the one awaited. */
  const watchedSessionOf = (run) => run.send?.sessionID ?? run.awaiting?.sessionID ?? null;

  /** The run may have been stopped, replaced or settled while a tick awaited. */
  const stillCurrent = (run) => !stopped && runs.get(run.originalSessionID) === run && run.status === 'running';

  /** Delivers the run's pending send into an idle session. */
  const deliver = async (run, records) => {
    const send = run.send;
    if (!send.messageID) {
      // One atomic user prompt owns its context and its stable admission ID.
      send.afterIdleID = newestIdleID(records);
      send.messageID = createMessageId(now());
      run.ownedMessages.push({ sessionID: send.sessionID, messageID: send.messageID });
    }
    // Also retry a previously failed write before retrying network admission.
    await persist();
    if (!stillCurrent(run)) return;
    // Before anything is admitted: a routing failure fails the whole attempt.
    if (routeSend) await routeSend({ sessionId: send.sessionID, directory: run.directory, text: send.text });
    if (!stillCurrent(run)) return;
    if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(send.sessionID, run.directory);
    if (!stillCurrent(run)) return;
    await openCodeClient().session.prompt({
      sessionID: send.sessionID,
      id: send.messageID,
      text: send.text,
      context: send.context.filter((text) => text.trim()).map((text) => ({ text })),
    }, requestOptions());
    if (!stillCurrent(run)) return;
    sendFailures.delete(run.originalSessionID);
    if (send.settle) {
      await settle(run, send.settle);
      return;
    }
    run.awaiting = { sessionID: send.sessionID, afterIdleID: send.afterIdleID ?? null };
    run.send = null;
    run.updatedAt = now();
    await commit(run.originalSessionID, run.directory);
  };

  /** The next send after a reply, or the run's end. */
  const advance = async (run, reply) => {
    run.awaiting = null;
    run.updatedAt = now();
    if (run.step === 'handoff') {
      run.step = 'review';
      run.send = {
        sessionID: run.reviewSessionID,
        text: fill(run.prompts.reviewStart, 'handoff', reply),
        context: [run.prompts.reviewRules, LOOP_RULES],
      };
    } else if (run.step === 'review') {
      const verdict = readReviewVerdict(reply);
      if (verdict.kind === 'disputed') {
        if (verdict.feedback) run.dispute = readDisputeSummary(verdict.feedback);
        return settle(run, 'disputed');
      }
      if (verdict.kind === 'clean' && !verdict.feedback) return settle(run, 'clean');
      run.step = 'implement';
      run.send = {
        sessionID: run.originalSessionID,
        text: fill(run.prompts.feedbackToImplementer, 'review_feedback', verdict.feedback),
        context: [],
      };
      // The reviewer's last word still reaches the implementer: nits included.
      if (verdict.kind === 'clean') run.send.settle = 'clean';
    } else {
      if (run.round >= MAX_ROUNDS) return settle(run, 'limit');
      run.round += 1;
      run.step = 'review';
      run.send = {
        sessionID: run.reviewSessionID,
        text: fill(run.prompts.responseToReviewer, 'implementation_response', reply),
        context: [LOOP_RULES],
      };
    }
    await commit(run.originalSessionID, run.directory);
    arm(run.originalSessionID, 0);
  };

  const WHO = { handoff: 'implementer', review: 'reviewer', implement: 'implementer' };

  async function tick(originalSessionID) {
    if (stopped || !isRunning(originalSessionID)) return;
    // An idle event that lands while a tick reads must not be lost.
    if (ticking.has(originalSessionID)) return arm(originalSessionID);
    const pending = tickRun(originalSessionID).finally(() => ticking.delete(originalSessionID));
    ticking.set(originalSessionID, pending);
    return pending;
  }

  async function tickRun(originalSessionID) {
    const run = runs.get(originalSessionID);
    const sessionID = watchedSessionOf(run);
    if (!sessionID) return;
    const watched = await readSession(sessionID);
    if (!stillCurrent(run)) return;
    if (watched === null) {
      const count = (readFailures.get(originalSessionID) ?? 0) + 1;
      readFailures.set(originalSessionID, count);
      return arm(originalSessionID, retryDelayMs(count));
    }
    readFailures.delete(originalSessionID);
    if (watched.kind === 'deleted') {
      return settle(run, 'failed', sessionID === run.reviewSessionID ? 'The review session was deleted.' : 'The reviewed session was deleted.');
    }
    // Running: its next idle event re-arms the tick.
    if (watched.kind === 'running') return;
    if (watched.kind === 'subagents') return arm(originalSessionID, subagentRecheckMs);

    if (run.send) {
      try {
        await deliver(run, watched.records);
      } catch (error) {
        if (!stillCurrent(run)) return;
        const count = (sendFailures.get(originalSessionID) ?? 0) + 1;
        sendFailures.set(originalSessionID, count);
        console.warn(`[auto-review] sending to ${sessionID} failed (attempt ${count}):`, error?.message ?? error);
        if (sessionGone(error, sessionID)) return settle(run, 'failed', `The ${WHO[run.step]} session is gone.`);
        if (count >= MAX_SEND_FAILURES) return settle(run, 'failed', `Could not send to the ${WHO[run.step]}: ${error?.message ?? error}`);
        return arm(originalSessionID, retryDelayMs(count));
      }
      // A turn short enough to end inside the send leaves no idle event
      // for later; this tick finds it running or reads its end.
      return arm(originalSessionID);
    }

    const outcome = readDispatchOutcome(watched.records, 0, run.awaiting.afterIdleID, { withText: true });
    if (!outcome) {
      // Idle without the run's idle record: it trails the event briefly, or
      // the prompt has not started. Short rechecks, then events take over.
      const spent = settleChecks.get(originalSessionID) ?? 0;
      if (spent < SETTLE_RECHECKS) {
        settleChecks.set(originalSessionID, spent + 1);
        arm(originalSessionID, settleRecheckMs);
      }
      return;
    }
    settleChecks.delete(originalSessionID);
    // The user stopped the turn: that stops the review too, and the row
    // says so instead of vanishing.
    if (outcome.state === 'cancelled') return settle(run, 'stopped');
    if (outcome.state === 'error') {
      return settle(run, 'failed', outcome.errorMessage ? `The ${WHO[run.step]}'s turn failed: ${outcome.errorMessage}` : `The ${WHO[run.step]}'s turn failed.`);
    }
    if (!outcome.text) return settle(run, 'failed', `The ${WHO[run.step]} finished without a text reply.`);
    await advance(run, outcome.text);
  }

  const reconcileAll = () => {
    for (const [originalSessionID, run] of runs) {
      if (run.status === 'running' && !timers.has(originalSessionID)) arm(originalSessionID);
    }
  };

  // --- public --------------------------------------------------------------

  /**
   * Starts a run for a review session the UI created. With a handoff, the
   * implementer writes it first; without, the reviewer starts from the diff.
   */
  const start = async (input) => {
    const parsed = startInputSchema.safeParse(input);
    if (!parsed.success) throw new TypeError(`invalid auto-review run: ${parsed.error.issues[0]?.message ?? 'bad input'}`);
    const { originalSessionID, reviewSessionID, directory, handoff, prompts } = parsed.data;
    if (originalSessionID === reviewSessionID) throw new TypeError('a session cannot review itself');
    await load();
    if (isHeld(originalSessionID) || stopping.has(originalSessionID)) throw httpError('an auto-review is running or not fully stopped for this session', 409);
    const previous = runs.get(originalSessionID);
    const run = {
      originalSessionID,
      reviewSessionID,
      directory,
      status: 'running',
      step: handoff ? 'handoff' : 'review',
      round: 0,
      prompts,
      send: handoff
        ? { sessionID: originalSessionID, text: handoff.text, context: [handoff.instructions] }
        : { sessionID: reviewSessionID, text: prompts.reviewStart, context: [prompts.reviewRules, LOOP_RULES] },
      awaiting: null,
      ownedMessages: [],
      startedAt: now(),
      updatedAt: now(),
    };
    runs.set(originalSessionID, run);
    if (runs.size > MAX_RUNS) {
      const oldest = Array.from(runs.values())
        .filter((candidate) => !holdsQueue(candidate))
        .sort((left, right) => left.updatedAt - right.updatedAt)
        .slice(0, runs.size - MAX_RUNS);
      for (const stale of oldest) runs.delete(stale.originalSessionID);
    }
    forgetLoopState(originalSessionID);
    try {
      await commit(originalSessionID, directory);
    } catch (error) {
      // Not on disk: a restart would lose it, so it does not start at all.
      if (previous) runs.set(originalSessionID, previous);
      else runs.delete(originalSessionID);
      await commit(originalSessionID, directory).catch(() => undefined);
      throw error;
    }
    // The first send waits for the session to be idle, so it never steers
    // into a turn that is still running.
    arm(originalSessionID, 0);
    return { revision, run: toPublicRun(run) };
  };

  const stopRun = async (run) => {
    const { originalSessionID } = run;
    run.status = 'stopping';
    delete run.error;
    run.updatedAt = now();
    forgetLoopState(originalSessionID);
    try {
      // Durable intent first: a restart must not restart the loop or release its queue.
      await commit(originalSessionID, run.directory);
      await ticking.get(originalSessionID);
      const failures = [];
      // An aborted HTTP request may still be preparing in OpenCode. Closing the
      // persisted ID seals future admission and waits for same-ID wake ownership.
      for (const { sessionID, messageID } of run.ownedMessages) {
        try {
          closeResultSchema.parse(await openCodeClient().session.inbox.close({ sessionID, inboxID: messageID }, requestOptions()));
        } catch (error) {
          if (!sessionGone(error, sessionID)) failures.push(`${sessionID}: ${error?.message ?? error}`);
        }
      }
      // Stop exactly these sessions, not their independent background children.
      for (const sessionID of [originalSessionID, run.reviewSessionID]) {
        try {
          const result = stopResultSchema.parse(await openCodeClient().session.stop({ sessionID }, requestOptions()));
          if (result.failed > 0) failures.push(`${sessionID}: ${result.failed} command termination(s) failed`);
        } catch (error) {
          if (!sessionGone(error, sessionID)) failures.push(`${sessionID}: ${error?.message ?? error}`);
        }
      }
      if (failures.length > 0) throw new Error(failures.join('; '));
      runs.delete(originalSessionID);
      try {
        await commit(originalSessionID, run.directory);
      } catch (error) {
        runs.set(originalSessionID, run);
        throw error;
      }
    } catch (error) {
      run.status = 'stop_failed';
      run.error = cut(`Review not fully stopped: ${error?.message ?? error}`, ERROR_CHAR_LIMIT);
      run.updatedAt = now();
      await commit(originalSessionID, run.directory).catch(() => undefined);
      throw httpError(run.error, 503);
    }
    return { revision, run: null };
  };

  /** Joins an active Stop; finished results are only dismissed, never stopped. */
  async function remove(originalSessionIDInput) {
    const originalSessionID = parse(sessionIdSchema, originalSessionIDInput);
    if (!originalSessionID) throw new TypeError('originalSessionID is invalid');
    await load();
    if (stopping.has(originalSessionID)) return stopping.get(originalSessionID);
    const run = runs.get(originalSessionID);
    if (!run) return { revision, run: null };
    if (holdsQueue(run)) {
      const pending = stopRun(run)
        .finally(() => stopping.delete(originalSessionID))
        .then(async (result) => {
          await onRunSettled?.(originalSessionID);
          return result;
        });
      stopping.set(originalSessionID, pending);
      return pending;
    }
    runs.delete(originalSessionID);
    forgetLoopState(originalSessionID);
    try {
      await commit(originalSessionID, run.directory);
    } catch (error) {
      runs.set(originalSessionID, run);
      throw error;
    }
    return { revision, run: null };
  }

  const processPayload = (payload) => {
    if (stopped) return;

    const deleted = parse(deletedEventSchema, payload);
    if (deleted) {
      const deletedID = deleted.properties.sessionID;
      // The reviewed session is gone: nothing is left to show the result in.
      if (runs.has(deletedID)) {
        void remove(deletedID).catch(() => undefined);
        return;
      }
      for (const run of runs.values()) {
        if (run.reviewSessionID === deletedID && run.status === 'running') arm(run.originalSessionID, 0);
      }
      return;
    }

    const status = parse(statusEventSchema, payload);
    if (!status) return;
    const sessionID = status.properties.sessionID;
    for (const run of runs.values()) {
      if (run.status !== 'running' || watchedSessionOf(run) !== sessionID) continue;
      if (status.properties.status.type === 'idle') {
        settleChecks.delete(run.originalSessionID);
        arm(run.originalSessionID);
      } else {
        clearTimer(run.originalSessionID);
      }
    }
  };

  const processEvent = (event) => {
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const startRuntime = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((hubStatus) => {
      if (hubStatus?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        const running = Array.from(runs.values()).filter((run) => run.status === 'running').length;
        if (running > 0) console.log(`[auto-review] resuming ${running} running review(s)`);
        reconcileAll();
      })
      .catch((error) => {
        // Unknown ownership holds all automatic delivery until a successful reread.
        console.warn('[auto-review] failed to load runs:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };

  return {
    load,
    snapshot,
    startRun: start,
    removeRun: remove,
    isRunning,
    speaksFor,
    /**
     * Whether the session's queue must wait: a run holds it, or the runs are
     * not loaded yet after a start. `startupLoad` resolves when they are.
     */
    holdsDelivery: (sessionID) => !startupLoadSettled || isHeld(sessionID) || stopping.has(sessionID),
    startupLoad,
    processPayload,
    start: startRuntime,
    stop,
    /** Shutdown drains server-owned work before its final persisted snapshot. */
    flush: async () => {
      await Promise.allSettled([...ticking.values(), ...stopping.values()]);
      await writePromise;
    },
  };
}

export function registerAutoReviewRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.get('/api/auto-review', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load auto-reviews');
    }
  });

  app.post('/api/auto-review/runs', async (req, res) => {
    try {
      res.json(await runtime.startRun(req.body));
    } catch (error) {
      respondError(res, error, 'Failed to start the auto-review');
    }
  });

  app.delete('/api/auto-review/runs/:originalSessionID', async (req, res) => {
    try {
      res.json(await runtime.removeRun(req.params.originalSessionID));
    } catch (error) {
      respondError(res, error, 'Failed to stop the auto-review');
    }
  });
}
