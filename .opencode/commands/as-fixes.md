---
description: Create an anti-slop lint cleanup PR from the next generated batch
agent: build
---

You are working in the OpenChamber repository.

Goal: reduce anti-slop Oxlint findings in a small, reviewable maintenance PR.

This task can run unattended on a schedule, so it must be safe to start at any moment and must stop cleanly when there is nothing to do.

First, verify the worktree is safe to use:

`git status --porcelain`

If the output is not empty, stop immediately and report that the worktree has uncommitted changes. Do not stash, reset, discard, commit, or switch branches. Local work in progress must never end up in a maintenance PR.

Then run:

`bun run deslop -- next-batch --min-issues 25 --max-issues 60`

Use the command output as the source of truth for this task scope.

If the output contains `NO BATCH AVAILABLE`, stop immediately and report the printed reason. Do not create a branch, do not create a pull request, and do not look for other work. Concurrency is already handled: the command excludes files claimed by other active batches and refuses to exceed the active-batch limit.

Background: anti-slop is a vendored Oxlint plugin at `tools/oxlint/anti-slop/`, configured in `oxlint.config.ts`. It rejects low-evidence typing: unjustified type assertions, `unknown`/`object`/`Record<string, unknown>` contracts, ad hoc `typeof` narrowing, conditional `{}` spreads, and module mocking. Fixing a finding means giving the code real type evidence, never hiding the symptom.

Workflow:
- Before generating the batch, switch to `main` and pull the latest remote changes.
- Read the `next-batch` output carefully.
- Use the exact `Run ID`, `Batch name`, `Branch name`, and `PR title` printed by the command.
- Create the branch using the printed `Branch name`.
- Work only on the selected files listed in the batch output.
- Treat the selected files as complete-file scope. Do not cherry-pick only the first N findings.
- Read each selected file fully before editing it. These findings sit on type contracts, so a local edit can change behavior at a distant call site.
- Fix as many findings as practical in the selected files. Your default should be to fix selected findings, not to skip them.

## What a good fix looks like

Every finding is the same underlying complaint: the code claims less about a value than it actually knows. A good fix restores the missing knowledge. A bad fix hides the complaint while the knowledge stays missing. The rule cannot tell the difference, so you must.

Before editing, answer one question for the value in question: where does it actually come from? There are only three answers, and each has one correct fix.

1. It comes from code in this repository. The real type already exists somewhere upstream. Find it and use it. No parsing, no assertion.
2. It crosses an I/O boundary: HTTP response, `postMessage`, file contents, `localStorage`, a child process, the OpenCode SDK edge. Parse it once at that boundary, then let the parsed type flow onward untouched.

On parsing style, follow local precedent and do not introduce a new one. `zod` is declared as a dependency but is not currently used in the source, so a maintenance PR is the wrong place to start spreading it. Unless the file or package you are editing already parses with a schema library, write a small local parse function that takes the raw input, returns the domain type or `undefined`, and lives next to the boundary it guards. If you believe a schema library is genuinely warranted, skip the finding and say so in the PR body instead of introducing the pattern yourself.
3. It is genuinely dynamic, such as a plugin registry keyed by arbitrary strings. Then keep the open key but make the value type precise, and say so in the contract's name.

### `no-unsafe-dictionary-type`

Bad, and the most common lazy fix. The shape is known; the annotation throws it away.

```ts
type QuotaSnapshot = Record<string, unknown>;

function readLimit(snapshot: QuotaSnapshot) {
  return snapshot.limit;
}
```

Good. Name the contract and state the fields the code actually reads.

```ts
type QuotaSnapshot = {
  limit: number;
  used: number;
  resetsAt: string;
};

function readLimit(snapshot: QuotaSnapshot) {
  return snapshot.limit;
}
```

Also good, when keys really are open but values are not.

```ts
type ProviderQuotas = Record<string, QuotaSnapshot>;
```

Still bad, and does not count as a fix:

```ts
type QuotaSnapshot = Record<string, any>;
type QuotaSnapshot = { [key: string]: object };
type QuotaSnapshot = Record<string, string | number | boolean | null>;
```

The third one is the sneaky one. Widening to a union of primitives satisfies the rule without describing anything. If you cannot name the fields, that is a signal the value is unparsed I/O; go to the boundary and parse it.

### `no-unknown-parameters`, `no-unknown-returns`, `no-unknown-type-aliases`

Bad. The function accepts anything and immediately guesses.

```ts
function applyThemeMessage(message: unknown) {
  const theme = message as { themeId: string };
  setTheme(theme.themeId);
}
```

Good. Parse at the boundary; the domain function receives a real type.

```ts
type ThemeMessage = { themeId: string };

function parseThemeMessage(data: MessageEvent["data"]): ThemeMessage | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const themeId = Reflect.get(data, "themeId");
  return typeof themeId === "string" ? { themeId } : undefined;
}

function applyThemeMessage(message: ThemeMessage) {
  setTheme(message.themeId);
}

window.addEventListener("message", (event) => {
  const message = parseThemeMessage(event.data);
  if (message === undefined) return;
  applyThemeMessage(message);
});
```

The parse function itself will still report `no-runtime-typeof` and `no-reflect-get`, because it is doing exactly what those rules describe. That is expected and acceptable: the checks are now concentrated in one named boundary function instead of scattered through domain logic, and the domain function above is genuinely typed. Report these remaining findings in the PR body rather than hiding them. Do not silence them with inline suppressions.

Note what changed at runtime: a malformed message is now ignored instead of silently producing `undefined` deeper in the call stack. That is a deliberate behavior decision and it belongs in the PR body. Never introduce a throw on a path that previously degraded quietly.

The `cause` convention is the single allowed exception: `unknown` is correct for an error cause.

### `no-known-value-widening`

Bad. The annotation erases the known keys, so callers lose autocomplete and typo safety.

```ts
const settingsBySlug: Record<string, SettingsSection> = {
  appearance: appearanceSection,
  keybindings: keybindingsSection,
};
```

Good. Keep inference and validate the shape.

```ts
const settingsBySlug = {
  appearance: appearanceSection,
  keybindings: keybindingsSection,
} satisfies Record<string, SettingsSection>;
```

`satisfies` checks every value against the contract while preserving the literal keys. Reach for it before anything else here.

### `no-chained-type-assertions` and `no-widen-then-assert`

Bad. The precise type existed and was thrown away, then guessed back.

```ts
const raw = loadSession() as unknown as SessionSnapshot;
```

Good. Fix the upstream contract so the round trip is unnecessary.

```ts
const snapshot = loadSession();
```

If `loadSession` genuinely returns something imprecise, that function is the real defect. Fix it there when it is inside the batch scope; if it is outside, make the minimal supporting change and say so in the PR body.

### `require-safety-comment-for-type-assertion`

The first move is always to delete the assertion, not to document it. Only a small minority of these findings deserve a comment.

Bad, and an automatic rejection at review:

```ts
// SAFETY: this is safe.
const session = value as Session;

// SAFETY: value is a Session.
const session = value as Session;

// SAFETY: required by TypeScript.
const session = value as Session;
```

These say nothing. A valid comment names the check that already ran and the line or function that ran it, so a reviewer can verify the claim without trusting you.

Good:

```ts
const parsed = sessionSchema.safeParse(payload);
if (!parsed.success) return undefined;
// SAFETY: sessionSchema.safeParse above confirmed every field of Session.
const session = parsed.data as Session;
```

If you cannot write such a sentence truthfully, you do not have an assertion problem, you have a missing check. Add the check.

### `no-conditional-empty-object-spread`

This one changes behavior more often than it looks, so read the consumer before editing.

Bad:

```ts
const body = {
  sessionId,
  ...(title !== undefined ? { title } : {}),
};
```

Good, when the consumer distinguishes a missing key from an explicit `undefined`, which is true for anything serialized to JSON or merged over defaults:

```ts
const body: CreateSessionBody = { sessionId };
if (title !== undefined) body.title = title;
```

Good, when the consumer treats both the same:

```ts
const body = { sessionId, title };
```

Choosing wrongly here sends `"title": null` or drops a field on a real API call. If you cannot determine which behavior the consumer needs by reading it, skip the finding and say why.

### `no-runtime-typeof`

Bad. An ad hoc check in the middle of domain logic.

```ts
function resolveHost(stored: unknown) {
  if (typeof stored === "string") return stored;
  return DEFAULT_HOST;
}
```

Good. Read and validate where the value enters the program, then branch on real domain values.

```ts
function readStoredHost(): string {
  const stored = localStorage.getItem(STORED_HOST_KEY);
  return stored !== null && stored.length > 0 ? stored : DEFAULT_HOST;
}
```

Here the fix removed the check entirely, because `localStorage.getItem` already has a precise contract: `string | null`. The original `unknown` was self-inflicted. Look for this case first; it is more common than it seems.

When a real check is unavoidable, keep it inside one named boundary function as shown above, and accept that the boundary function keeps its finding. What is not acceptable is spreading the same check across domain code, or renaming it into a type predicate so it reads as intentional while nothing was actually established.

### `no-module-mocking`

Bad. The test mocks a module and therefore tests the mock.

```ts
mock.module("../lib/runtimeFetch", () => ({ runtimeFetch: async () => ({ ok: true }) }));
```

Good. Pass the dependency in, and let the test supply a real function.

```ts
async function loadStatus(fetchStatus: () => Promise<StatusResponse>) {
  return fetchStatus();
}

test("returns the fetched status", async () => {
  const status = await loadStatus(async () => ({ ok: true }));
  expect(status.ok).toBe(true);
});
```

If introducing the seam would restructure production code well beyond the batch, skip the finding and say so. Do not fake a seam you do not believe in.

## How to know your fix is real

Before moving to the next finding, check all four:

- The code now knows something it did not know before. If you only rearranged syntax, it is not a fix.
- No new `any`, no new assertion, no new broad union invented to satisfy the checker.
- If you added parsing, you decided explicitly what happens on invalid input, and that decision is written in the PR body.
- If you changed a type used elsewhere, you searched for its call sites and updated them, rather than casting at the call site.

Handle findings deliberately instead of skipping them: for parsing work, add the smallest schema that covers the fields actually used; for contract changes, follow call sites with search and update them; for tests, prefer real seams over widened fixtures.

Skip a finding only when the fix would require broad architectural changes, unclear behavior changes, or changes outside the selected batch scope. If skipped, mention it in the PR body.

Hard prohibitions. Each of these makes the lint output greener while making the code worse, and each is grounds for rejecting the whole PR:
- Do not disable, downgrade, or ignore anti-slop rules, in configuration or with inline comments.
- Do not add `any`, widen a type, or add an assertion in order to satisfy a rule.
- Do not write a generic or placeholder `// SAFETY:` comment. A comment that does not name a real, already-performed check is worse than the original finding.
- Do not invent a union of primitives to escape a dictionary rule.
- Do not move a rejected `typeof` check into a hand-written type predicate to get it out of the linter's way.
- Do not delete code, tests, or fields to make a finding disappear.
- Do not rename a symbol solely to dodge `no-shape-in-symbol-names`; rename it to what it actually is.
- Do not introduce a throw where the previous code degraded quietly. A parse failure on a path that used to fall back must keep falling back.
- Do not introduce a schema library, a new utility module, or a new architectural pattern as part of a lint cleanup.
- Do not edit `oxlint.config.ts` or `tools/oxlint/anti-slop/`.
- Do not edit `CHANGELOG.md`, package versions, or release metadata. This is internal maintenance with no user-facing change.
- Do not fix findings outside the selected files.

After edits, run:

`bun run deslop -- check-batch --run <run-id>`

Then validate the packages you actually touched, not the whole workspace. For each affected package run its own checks, for example:

`bun run --cwd packages/ui type-check`

`bun run --cwd packages/ui lint`

`bun run --cwd packages/ui test`

Workspace-wide `bun run type-check` and `bun run lint` are CI's job. Run them locally only when a change crosses package boundaries or touches shared contracts.

For files that TypeScript does not cover, such as server or CLI JavaScript, run the focused tests for that surface instead, for example `bun run --cwd packages/web test`.

Validation and delivery:
- Confirm selected files have fewer findings than before.
- Confirm `Findings outside selected files delta` is not positive. If it is, you introduced new findings elsewhere; fix them before continuing.
- If validation fails, fix failures only if the fixes stay within the task scope. Otherwise stop and report the blocker.
- Commit the changes with a concise message.
- Push the branch.
- Create exactly one PR with `gh pr create` using the exact printed `PR title`.
- After the PR is created, switch back to `main` and pull the latest remote changes again.

PR requirements:
- Use the exact printed `PR title`.
- Include the `Run ID`, `Batch name`, and `Branch name`.
- Include selected files.
- Include findings fixed according to `check-batch`.
- Include remaining findings in selected files.
- Include validation results for `check-batch` and every package-scoped type-check, lint, and test command you ran, naming the packages.
- Include a `Manual testing recommendations` section with focused checks for the changed behavior, based on the selected files and actual edits. Type-contract changes can alter runtime behavior at call sites, so name the affected surfaces concretely.
- Include any skipped findings and why.
- Include any `// SAFETY:` comment you added, with the invariant it documents.
- Include every parsing decision you introduced: what schema was added, and what now happens when input fails to parse. Reviewers must be able to see where behavior changed without reading the whole diff.

Constraints:
- Keep the PR small and reviewable.
- Do not auto-merge.
- Do not modify unrelated files except minimal supporting changes required by selected-file fixes.
- Do not run broad formatting.
- Leave the batch's run directory intact after creating the PR. `next-batch` prints its location. That directory is both the handoff for the review follow-up task and the claim that stops another batch, including the React Doctor pipeline, from touching the same files. Deleting it early lets a parallel batch collide with this PR. Never delete it by hand; use `bun run deslop -- release --run <run-id>`.
- If you stop before creating a PR for any reason, release the claim with `bun run deslop -- release --run <run-id>` so the files return to the pool.
