# Auto-review

## Ownership

Owns the automatic review loop: a review session and the session it reviews
pass the review, the fixes and the re-review between them until the reviewer
has nothing left, without the user carrying the messages. The loop runs in the
web server, so a closed tab, a locked phone or a dropped connection does not
stop it halfway.

The UI (`packages/ui/src/lib/reviewFlow.ts`) owns the start: it creates or
reuses the review session (title, metadata link, model, agent, permission mode)
and renders every prompt the run will send from the magic prompts, with the
`{{handoff}}`, `{{review_feedback}}` and `{{implementation_response}}`
placeholders left in. From `POST /api/auto-review/runs` on, this module does
every send. The manual review (no auto-review) and the "send to the other
session" buttons stay in the UI and never touch this module.

Wiring: created in `server/index.js` before the message queue, routes in
`opencode/feature-routes-runtime.js` (JSON bodies in `opencode/core-routes.js`),
stopped by `opencode/shutdown-runtime.js`.

## Run

`{ originalSessionID, reviewSessionID, directory, status, step, round, prompts,
send, awaiting, ownedMessages, error?, dispute?, startedAt, updatedAt }`, keyed by the
reviewed session, at most one per session. `status` is `running`, or how it
ended: `clean` (nothing left, the reviewer's last word was delivered to the
implementer), `disputed` (only declines the reviewer still contests, with
`dispute`), `limit` (5 re-reviews without an end), `failed` (with `error`),
`stopped` (the user aborted the turn the run waited on). A requested Stop first
becomes `stopping`, then removes the row only after cleanup is confirmed.
`stop_failed` retains the error, ownership and queue hold for a retry.
`step` is what the run is getting: the implementer's `handoff`, the
reviewer's `review`, the implementer's answer in `implement`.

Persisted in `<data-dir>/auto-review.json`, written atomically through a
serialized write chain, owner-readable only (prompts and handoffs are
conversation content). A missing file is no runs. Read, format or ownership
validation failure preserves the file and keeps writes and all queue automatic
delivery off until a load succeeds; it is never converted into an empty or
terminal snapshot. Existing load requests retry a failed load. Version 2 stores
the complete attempted-message ledger; an older/unreadable record without
provable ownership cannot authorize automatic delivery or successful cleanup.
The previous local frontend loop had no server-owned file to migrate.
At most 100 runs, the oldest finished ones dropped first. Only the start input
is capped (100 000 characters per prompt); the text a run builds from a reply
is stored whole, however long the reply. `error` is cut to 500 characters, one
line in the result row; `dispute` to 2 000, what the row unfolds. Timers and failure counts are memory only; a restart
re-arms every running run. Restored `stopping` and `stop_failed` runs remain
held and never send; the row offers Stop again after a restart.

## Loop

Each step is one send and the end of the turn it starts.

1. A send waits until its session's turn is over: not in
   `/api/session/active`, no running subagent
   (`../opencode/session-activity.js`), so a prompt never steers into a live
   turn. Unknown is never idle: a failed read retries with backoff.
2. Before the first attempt the send gets its baseline, the session's newest
   `idle` record, and a single stable prompt ID in OpenCode's `msg_` format.
   Both and the run's ownership ledger are saved before any admission attempt.
   Retries reuse the ID: OpenCode accepts an identical retry idempotently;
   a conflict is a failure, not evidence of delivery.
3. A session on the Auto model is routed first: this module posts to OpenCode
   directly, past the proxy's routing rewrite, so `routeSend` (the routing
   runtime's, wired in `server/index.js` for sessions it has marked Auto)
   picks the model for this prompt's text and switches the session onto it.
   A routing failure fails the attempt before anything is admitted. Then the
   session's project knowledge is synced, as for a UI send. Context and text go
   together in one SDK `session.prompt` call (`context: [{ text }]`), with no
   standalone synthetic context to orphan. Any other
   session keeps the model and agent it holds. The UI puts the dialog's model
   and agent on a review session it reuses from an earlier review, since a new
   one is created on them.
4. The turn is over when the session is idle and OpenCode has appended an
   `idle` record newer than the baseline (`readDispatchOutcome` of
   `../dispatch-results`, with `withText`: the text comes from the newest reply
   of the turn that has any). `interrupted` settles it as `stopped`, `failed`
   settles it as failed with OpenCode's message, a turn with no text fails it
   too.
5. The reply decides the next send. The handoff fills `{{handoff}}` of the
   reviewer's first prompt, which carries the review rules and the loop rules
   as context. A review ending in `FINAL_REVIEW_STATUS: disputed` settles as
   disputed; the loop rules ask the reviewer to put a `Disputed findings:` line
   above the marker with both positions in two or three lines each, and
   `readDisputeSummary` keeps what follows the last such line (the whole review
   when there is none) as `dispute`. One ending in `FINAL_REVIEW_STATUS: no_remaining_findings` sends
   what came before the marker to the implementer and settles as clean (with
   nothing before it, it settles at once); anything else goes to the
   implementer. The implementer's answer goes back to the reviewer with the
   loop rules, until 5 re-reviews (`MAX_ROUNDS`) settle as `limit`. Five is
   on purpose: a loop that has not settled by then is going in circles, and
   each further round mostly grows the change.

The loop rules (`LOOP_RULES`) and their markers live here, since only this
module reads them. A send that fails five times in a row settles as failed; a
404 settles at once (the session is gone). Status events (`session.status`
idle) arm a 500 ms quiet timer for the session a run watches; a hub reconnect
and startup re-arm every running run; after a send the run checks once on its
own, so a turn that ends inside the send is still read. `session.deleted` of
the reviewed session removes its run.

## Message queue

A running run holds the reviewed session's queue (`isDeliveryHeld` of
`../message-queue`, answered by `holdsDelivery`), because the session goes idle
between steps and a queued follow-up would land in the middle of the review.
Settling or successfully stopping a run calls `release`, which delivers what waited. After
a start, every session counts as held until this module's first load succeeds
(`startupLoad`, the queue's `deliveryHoldReady`): the two files load
independently, and a queue that loaded first would otherwise deliver into a
run it did not know about yet. Failed reads and malformed files keep the global
hold: ownership is unknown, so no queue can be proved safe. Manual sends and
opening sessions do not use this automatic-delivery hold.

## Stop ownership

The server persists `stopping` before cleanup and joins duplicate Stop requests.
It blocks further loop sends, drains its in-flight tick, then seals every
persisted `(sessionID, messageID)` through SDK `session.inbox.close`. The backend
durably closes late admission and coordinates same-ID admission/wake; pending
context is cancelled with its prompt, while delivered history is left intact.
Only then does the server call `session.stop` for the original and review
sessions. Both calls are attempted even if one close/stop fails. Persistent
commands are included; independent background child sessions and ordinary
messages/other notifications are not cancelled or recursively stopped.

Any unknown response, timeout, closure failure or nonzero `failed` termination
count leaves `stop_failed` and its queue hold. Retry uses the same IDs. The
record is durably removed before the queue is released, and a finished result's
dismissal never invokes either session operation. The UI keeps the row during
the request and takes newer server revisions rather than restoring stale state.

Host shutdown disarms the loop with `stop()` and awaits `flush()` in
`opencode/shutdown-runtime.js`. The flush joins in-flight ticks and user Stop
operations before the final serialized writes, so normal exit waits for the
Stop intent and its cleanup result to reach disk. It runs alongside managed
OpenCode teardown under the shared host deadline, with time reserved for HTTP
closure. Deadline exhaustion warns and allows exit; it cannot guarantee a
still-pending write. Shutdown itself does not request Stop for running reviews,
which resume on the next start.

## Notification

Every step ends a turn of one of the two sessions, and each would announce
itself as a "ready" notification. `speaksFor(sessionID)` tells the
notification runtime (`../notifications/runtime.js`, `isInAutoReview`) that a
turn belongs to a run: either session of a running run, or of one that
settled after that turn ended, since a run settles on the idle of its last
step and may do so before the notification asks. A turn that ends after the
run settled, such as a queued follow-up the end released, notifies as usual. Those turns announce nothing. A run
that ends on its own (`clean`, `disputed`, `limit`, `failed`) calls
`onRunEnded`, and the notification runtime sends one notification for the
reviewed session (`notifyAutoReviewEnded`), under the completion toggle. A
`stopped` run announces nothing: the user just stopped it. The host's
notifications for a chat of an isolated space do not ask the space's runs
(`spaceId` skips the check), so a review inside a space keeps its per-step
"ready" notifications.

## Routes and events

| Route | Purpose |
|---|---|
| `GET /api/auto-review` | `{ revision, runs[] }` without the prompts |
| `POST /api/auto-review/runs` | Start: `{ originalSessionID, reviewSessionID, directory, handoff?: { text, instructions }, prompts: { reviewStart, reviewRules, feedbackToImplementer, responseToReviewer } }`; 409 while a run of that session is running |
| `DELETE /api/auto-review/runs/:originalSessionID` | Stop/retry a held run, or dismiss a finished result; 503 retains an incomplete Stop |

Every change broadcasts `openchamber:auto-review.updated`
`{ revision, originalSessionID, directory, run | null }` on the control stream
(`/api/openchamber/events`) and the WS fan-out. `revision` is one counter per
server; the UI projection (`packages/ui/src/stores/useAutoReviewStore.ts`)
orders by it per owner.

A session in an isolated space has its run in the server inside the space,
which sees that space's OpenCode: the UI addresses the request by the
session's directory. The host forwards the space's changes from the same
control-stream connection it opens for the space's queue, marked with
`spaceId`, only when the space speaks for both sessions of the run
(`../spaces/space-events.js`); an over-long `error` is cut there rather than
the update dropped. A space's own snapshot reaches the browser through the
proxy unfiltered, so the UI keys every run by its owner and a chat reads under
the owner of its own directory: a space that names a host session lands its
run under itself, where no host chat looks.

## Runtime parity

Web, desktop and both mobile clients start and see runs on the server they are
connected to, and the result row shows on every client of that server. VS Code
has no OpenChamber server: the review dialog offers no auto-review there, and
the manual review works as before.

## Decisions

### Why Stop is server-owned and message IDs are sealed

Browser-side sequential calls leave cleanup unfinished on disconnect and can
release queued input too early. Cancelling the current inbox alone cannot stop
a timed-out prompt that is still preparing; durable same-ID closure proves
that late admission cannot wake either session after a successful Stop.

### Why an unreadable file holds unrelated queues

All ownership is in one file. Releasing queues or replacing malformed runs with
terminal rows would silently bypass an unconfirmed Stop. Until a successful
reread identifies the held sessions, automatic delivery waits globally instead.

### Why the loop runs on the server and not in the window that started it

The loop used to poll the browser's session stores. Closing the tab, locking
the phone or switching the runtime stopped it, and the message queue needed a
hold the UI re-asserted every two minutes, which expired when the UI was gone.
On the server the loop sees OpenCode directly, survives the window, and holds
the queue by asking the run itself.

### Why the UI renders the prompts and the server fills the placeholders

Magic prompt defaults live in the client (`packages/ui/src/lib/magicPrompts.ts`),
and the server only stores overrides. Rendering at start with the placeholders
kept means one read of the overrides for the whole run, the same text a manual
review sends, and no second copy of the defaults on the server.

### Why the reviewer can end on a dispute

With one marker, a finding the implementer declined and the reviewer kept
contesting went round until the limit, and the run ended looking the same as a
manual stop. The second marker ends the run as soon as only contested declines
are left, and the result row tells the user it is their call. The row unfolds
the reviewer's summary of both positions, so deciding does not start with
reading two sessions.
