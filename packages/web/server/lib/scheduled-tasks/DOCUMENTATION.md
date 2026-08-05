# Scheduled Tasks module

Server-owned scheduled task runtime and routes for OpenChamber-only automation.

## Scope

- Per-project scheduled task persistence is owned by `packages/web/server/lib/projects/project-config.js`.
- Markdown loop discovery/parsing is owned by `packages/web/server/lib/scheduled-tasks/loops.js`.
- Runtime orchestration and execution is owned by `packages/web/server/lib/scheduled-tasks/runtime.js`.
- This module is OpenChamber feature logic; it is intentionally separate from OpenCode proxy/runtime internals.

## Files

- `packages/web/server/lib/scheduled-tasks/runtime.js`
  - Next-run computation (daily/weekly/cron compatibility)
  - Timer scheduling and queueing
  - Concurrency controls
  - Session create + prompt_async execution
  - Emits OpenChamber task-run events

- `packages/web/server/lib/scheduled-tasks/loops.js`
  - Discovery of `.agents/loops/*.md` (project scope, ancestors up to the worktree root) and `~/.agents/loops/*.md` (user scope)
  - Frontmatter parsing into scheduled-task definitions
  - `syncProject` reconciles discovered loops with the persisted task list on every project sync (startup, task save/delete)

- `packages/web/server/lib/scheduled-tasks/routes.js`
  - Scheduled task CRUD endpoints
  - Manual run endpoint
  - OpenChamber events SSE stream endpoint

## Loop file format

Portable, git-commit-able scheduled-task definitions:

```markdown
---
name: daily-digest
schedule: "0 9 * * *"
enabled: true
model: anthropic/claude-sonnet-4-5
agent: plan
timezone: Europe/Kyiv
---
Summarize repository changes since yesterday.
```

Field mapping (model: `packages/ui/src/lib/scheduledTasksApi.ts`):

| Frontmatter | Task field |
|---|---|
| `name` | `name` (required) |
| `schedule` | `schedule.kind: "cron"` + `schedule.cron` (required, cron-only in the portable format) |
| `enabled` | `enabled` (default `true`) |
| `model` | split on the first `/` into `execution.providerID` / `execution.modelID` (required) |
| `agent` | `execution.agent` (optional) |
| `timezone` | `schedule.timezone` (optional, IANA; defaults to the server zone) |
| body | `execution.prompt` (required) |

`thinking_level` and `goalEnabled`/`goalTokenBudget` are not part of the portable
format (UI/JSON-only today); `daily`/`weekly`/`once` schedules remain UI/JSON-only.
Runtime state (`lastRunAt`, `nextRunAt`, `lastStatus`, `lastError`, `lastSessionId`,
`lastDurationMs`) is never written to the markdown file — it continues to live in
the project config state store.

## Loop reconciliation rules

`projectConfigRuntime.reconcileLoopTasks(projectID, loops)` runs inside the
project write lock on every `syncProject` when the project path is known:

- **Identity is the task name.** A loop whose name matches an existing task
  takes that task over: its schedule/execution/enabled are overwritten from the
  file while the task's `id` and runtime `state` are preserved (markdown wins
  on conflict with JSON-configured tasks).
- **Deletion.** A task carrying the `loopFile` marker whose loop file is no
  longer discovered (removed or renamed) is unscheduled (removed from the
  config). The marker is persisted in the config file, so removal is detected
  across restarts. JSON-configured tasks without the marker are never removed.
- **Creation.** Loops without a matching task are created under a deterministic
  `loop:<scope>:<name>` id so runtime state survives restarts.
- **Scope precedence.** Project-scope loops shadow user-scope loops with the
  same name; among project files the nearest ancestor wins.
- **Malformed files** (missing `name`/`schedule`/`model`/body, invalid cron,
  unreadable) are skipped with a warning and never block valid loops in the
  same or other scopes.
- **UI edits** to a loop-sourced task are preserved in the config but the loop
  file remains authoritative: the next reconciliation re-applies the file's
  definition (including `enabled`). Use `enabled: false` in the file to disable.

## Public exports (runtime.js)

- `createScheduledTasksRuntime(dependencies)`
- Returned API:
  - `start()`
  - `stop()`
  - `syncAllProjects()`
  - `syncProject(projectId)`
  - `runNow(projectId, taskId)`

## Public exports (routes.js)

- `registerScheduledTaskRoutes(app, dependencies)`
- Registers:
  - `GET /api/projects/:projectId/scheduled-tasks`
  - `PUT /api/projects/:projectId/scheduled-tasks`
  - `DELETE /api/projects/:projectId/scheduled-tasks/:taskId`
  - `POST /api/projects/:projectId/scheduled-tasks/:taskId/run`
  - `GET /api/openchamber/scheduled-tasks/status`
  - `GET /api/openchamber/events`
