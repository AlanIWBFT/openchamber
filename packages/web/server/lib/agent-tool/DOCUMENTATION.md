# Managed OpenChamber Agent Tool

## Purpose

This module exposes OpenChamber to agents as typed OpenCode custom tools. There
are two, because controlling sessions and driving a page are separate intents
the user can want independently:

- `openchamber` — projects, sessions, worktrees, scheduled tasks, and showing
  a file to the user (`file.open`). Enabled while the persisted
  `agentControlToolEnabled` setting is not `false`.
- `openchamber_web` — looking at and interacting with the page in OpenChamber's
  browser panel. Enabled while `agentWebToolEnabled` is not `false`.
- `openchamber_notify` — `notify.send`, a notification to the user through
  `lib/notifications/emit-route.js` (same limits and rate window as
  `POST /api/notifications/emit`). Off by default: enabled only while
  `agentNotifyToolEnabled` is `true`, and the control service refuses the
  action when the setting is off, so a stale plugin cannot keep paging.

Both default to on, are toggled in Settings → General → OpenChamber Tools, and take
effect in the running OpenCode within a couple of seconds — OpenChamber rewrites
the managed config file OpenCode watches (see
`lib/opencode/managed-config-file.js`). Installs where the user's own
environment sets `OPENCODE_CONFIG` fall back to `OPENCODE_CONFIG_CONTENT` and
still need a restart for a toggle. Each tool carries only its own actions and
only the parameters those actions use, so turning one off removes its inputs
from the schema rather than leaving them visible. The plugin is injected only
when OpenChamber launches and owns the OpenCode process, and not at all when
both settings are `false`.

- Every tool is registered with `options: { codemode: false }`, so it is a
  direct tool in the model's tool list. OpenCode 2 otherwise puts plugin tools
  behind its Code Mode `execute` tool, where the model sees only a
  size-limited catalog; with a few large MCP servers ours dropped out of it and
  agents concluded the tool did not exist. `agentToolsCodeMode: true` (the
  "Run through Code Mode" checkbox in the same section, off by default) flips
  all of them to `codemode: true`.
- The advertised input is `{ request: { action, ...inputs } }`. The execution
  adapter retains legacy flattened and `parameters` inputs, with `request`
  taking precedence. New calls use the request schema.

## Runtime flow

1. The OpenChamber HTTP listener binds and publishes its authoritative port.
2. `materializePlugin()` writes the plugin under
   `<openchamber-data-dir>/agent-tool/` and returns its directory; the managed
   config layer lists that directory in `<data-dir>/opencode.managed.json` and
   rewrites the file whenever a tool setting changes.
3. `createChildEnv()` adds a random per-child token and the callback URL to the
   managed OpenCode child environment. They are present even while every tool
   is off, so a tool switched on later can call back without a restart. The URL
   points at loopback, except when the listener is bound to one concrete
   address (`--host <ip>`): that socket does not answer on loopback, so the URL
   uses the bound address instead.
4. The plugin unwraps `request` and calls `POST /api/openchamber/agent-tool` with the action input and
   the session id OpenCode gives the tool; OpenChamber resolves the session's
   directory on its own side.
5. The route delegates the fixed action allowlist directly to the shared
   OpenChamber control service. The CLI uses the same service through its
   authenticated HTTP adapter, so Goal Mode ordering, CLI wait behavior,
   result delivery, partial-failure reporting, and scheduled-task contracts
   have one owner.
6. Each action definition owns a short presentation title and a separate
   agent-facing description. The generated schema uses the description to state
   required inputs, one non-obvious behavior, or one compact example, while
   completed calls use the short title in native tool metadata.

## Agent context budget

- The action schema carries `oneOf` and no `enum`. A node combining `enum` and
  `oneOf` is valid JSON Schema, but some OpenAI-compatible gateways reject it
  and answer with an empty completion instead of an error.
- The tool exposes one shared `request` object rather than repeating parameters
  in a large per-action union. Keeping this object distinct from a generic
  parallel wrapper's `parameters` field prevents one layer from being mistaken
  for the other. Action descriptions carry only required inputs, defaults, or
  one non-obvious semantic detail.
- Obvious fields rely on their names and JSON types. Parameter descriptions are
  reserved for formats, dependencies, scope, and behavior that cannot be safely
  inferred from the field name.
- Session dispatches never wait. An agent that needs the outcome sets
  `returnResult`: the call still returns at once, with
  `resultDelivery.status: 'pending'` and a note telling the agent not to poll
  or sleep, and the session's final answer is delivered into the calling
  session when it finishes (`../dispatch-results/`). The schema carries no
  `wait` or `timeout`, and the adapter answers a stale `wait`, `timeout`, or
  `lastAssistant` on a dispatch with a usage error naming `returnResult`
  (`agentOnlyUsageError`). `session.messages` does not wait either: it reads
  what is there. The control service keeps `wait` for the CLI only.
- The description draws the line against OpenCode's own `subagent` tool:
  `subagent` when the agent delegates part of its own task and wants the
  answer for itself, `session.*` when the user asks for a separate session
  they will follow and talk to.
- JSON Schema owns types, enums, and numeric ranges. Shared descriptions own
  cross-action scope and selection rules; action descriptions own only their
  distinctive dependencies and compact examples.
- The tool exposes only agent-relevant actions
  (`OPENCHAMBER_AGENT_TOOL_ACTIONS`): `schedule.status` stays CLI-only because
  `schedule.list` already returns scheduler status, and enable/disable are one
  `schedule.toggle` action driven by the `disabled` boolean.
- The tool description frames intent: created sessions and scheduled tasks are
  user-facing work the user follows up with. The agent must not decide on its
  own to delegate parts of its current task, but an explicit user request to
  create, send, or schedule always wins, even when it relates to the current
  task (strict models otherwise read the old unconditional "never delegate" as
  a hard ban and refused user-requested sends).
- Optional behavior switches (`worktree`, `goal`, `agent`, `variant`,
  `returnResult`) state their default and an explicit "only when the user
  asks" rule so agents do not invent worktrees, goal mode, or result
  deliveries the user never requested.
- A rule about when to act belongs where the model reads it before choosing a
  tool: the head of the tool description and, when it must hold in every
  session, the session context (`../session-knowledge/`). An action's
  description is read only after the tool was chosen, so a trigger placed
  there is missed by an agent that never thought the tool applied. Seen with
  `session.link`: told only in the action, an agent investigating an issue
  never linked it; with the rule at the head of the description and in the
  session context, the next agent linked the issue first thing (2026-10-02).
  Action descriptions say what the action does and takes.
- Combination rules that commonly cause avoidable retries are summarized in the
  relevant action description. The shared control service still owns exhaustive
  validation and returns actionable errors without a repeated per-action schema.

## Security invariants

- The callback accepts same-machine requests only and requires the current
  per-child bearer token using a timing-safe comparison. Same-machine means a
  loopback source, or, for a listener bound to one concrete address, a source
  equal to that address: the OS sources a local connection to `<ip>` from
  `<ip>`. A wildcard bind keeps the loopback-only rule, and another machine on
  the network always arrives with its own address.
  `callback-address.js` owns this rule; the repository credential helper
  (`lib/git/repository-credential-runtime.js`) reaches the server the same way
  and shares it.
- The token is never persisted, logged, returned to the UI, or written into
  the materialized plugin.
- The plugin adds the callback host to `NO_PROXY`/`no_proxy` inside the managed
  child when it loads. Without that, an `HTTP_PROXY` in the child's environment
  would receive a non-loopback callback, token included, because `fetch` has no
  per-request way to skip the environment proxy.
- Inputs map to a fixed action and parameter allowlist. There is no arbitrary
  CLI, shell, route, or URL forwarding.
- Session/worktree deletion and project-path registration are not exposed.
- A cancelled turn aborts the session's in-flight actions. OpenCode 2 gives a
  plugin tool no abort signal and the plugin's request stays open, so the
  server tracks in-flight actions per session and `abortSession(sessionID)` is
  called from the event dispatch in `server/index.js` when the stream reports
  `session.idle` with `aborted: true`; the abort signal then reaches the
  shared service as before. A dropped HTTP request still aborts as well.

## Result contract

Every completed call returns JSON:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "action": "session.create",
  "data": {}
}
```

Command and operational failures use the same envelope with `ok: false` and
an `error` object. OpenCode-level cancellation can still produce a native tool
error state.

## Runtime parity

- Web and Desktop managed OpenCode: injected automatically.
- External OpenCode selected with `OPENCODE_HOST` or skip-start: not injected,
  because OpenChamber does not control that process environment.
- VS Code: not injected; the extension owns a separate OpenCode lifecycle.
- Hosted and Capacitor mobile clients use the server's managed OpenCode tool
  when connected to such a server; no tool runs in the client runtime.

## The calling tool is part of the request

Each generated tool sends its own name with every callback. Models routinely
drop the namespace their tool's name appears to supply — `openchamber_memory`
asked for `memory.read` gets called as `read` — and resolving the bare name
inside the calling tool's action set makes that unambiguous even where it is not
globally (`delete` belongs to both schedule and memory).

Resolution never reaches outside the tool that asked: `open` from the memory
tool fails rather than driving the browser. An unresolvable action answers with
the actions that tool actually has, because an error that only says
"unsupported" leaves the model to guess a second wrong name — which is exactly
what happened before this existed.
