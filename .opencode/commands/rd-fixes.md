---
description: Create a React Doctor diagnostics cleanup PR from the next generated batch
agent: build
---

You are working in the OpenChamber repository.

Goal: reduce React Doctor diagnostics in a small, reviewable maintenance PR.

This task can run unattended on a schedule, so it must be safe to start at any moment and must stop cleanly when there is nothing to do.

First, verify the worktree is safe to use:

`git status --porcelain`

If the output is not empty, stop immediately and report that the worktree has uncommitted changes. Do not stash, reset, discard, commit, or switch branches. Local work in progress must never end up in a maintenance PR.

Then run:

`bun run doctor -- next-batch --min-issues 75 --max-issues 120`

Use the command output as the source of truth for this task scope.

If the output contains `NO BATCH AVAILABLE`, stop immediately and report the printed reason. Do not create a branch, do not create a pull request, and do not look for other work. Concurrency is already handled: the command excludes files claimed by other active batches and refuses to exceed the active-batch limit.

Workflow:
- Before generating the batch, switch to `main` and pull the latest remote changes.
- Read the `next-batch` output carefully.
- Use the exact `Run ID`, `Batch name`, `Branch name`, and `PR title` printed by the command.
- Create the branch using the printed `Branch name`.
- Work only on the selected files listed in the batch output.
- Treat the selected files as complete-file scope. Do not cherry-pick only the first N diagnostics.
- Fix as many diagnostics as practical in the selected files. Your default should be to fix selected diagnostics, not to skip them.
- Prefer direct, behavior-preserving fixes: missing effect cleanup, mutable effect dependencies, accessibility issues with semantic fixes, local performance improvements, Tailwind shorthand replacements, component extraction when the boundary is clear, dead-code removal after verifying no references, and reducer or derived-state cleanup when the state relationship is local and clear.
- Handle larger diagnostics deliberately instead of skipping them: for component splits, extract the smallest coherent subcomponent that reduces the diagnostic while preserving props/state flow; for dead code, verify references with search before deleting exports, types, or files; for state architecture issues, prefer the smallest local reducer or derived-state simplification that preserves behavior; for render-function extraction, extract only stable render helpers that do not depend on large implicit closure state, or pass explicit props; for behavior-sensitive diagnostics, read the surrounding code first and preserve existing runtime behavior.
- Skip a diagnostic only when the fix would require broad architectural changes, unclear behavior changes, or changes outside the selected batch scope. If skipped, mention it in the PR body.
- Do not suppress React Doctor diagnostics unless there is a clear false positive.
- If a listed diagnostic requires changes outside the selected files, make only the minimal required supporting change. Do not expand the cleanup scope.

After edits, run:

`bun run doctor -- check-batch --run <run-id>`

Then validate the packages you actually touched, not the whole workspace. For each affected package run its own checks, for example:

`bun run --cwd packages/ui type-check`

`bun run --cwd packages/ui lint`

`bun run --cwd packages/ui test`

Workspace-wide `bun run type-check` and `bun run lint` are CI's job. Run them locally only when a change crosses package boundaries or touches shared contracts. For files that TypeScript does not cover, such as server or CLI JavaScript, run the focused tests for that surface instead.

Validation and delivery:
- Confirm selected files have fewer diagnostics than before.
- If validation fails, fix failures only if the fixes stay within the task scope. Otherwise stop and report the blocker.
- Commit the changes with a concise message.
- Push the branch.
- Create exactly one PR with `gh pr create` using the exact printed `PR title`.
- After the PR is created, switch back to `main` and pull the latest remote changes again.

PR requirements:
- Use the exact printed `PR title`.
- Include the `Run ID`, `Batch name`, and `Branch name`.
- Include selected files.
- Include diagnostics fixed according to `check-batch`.
- Include remaining diagnostics in selected files.
- Include validation results for every package-scoped type-check, lint, and test command you ran, naming the packages.
- Include a `Manual testing recommendations` section with focused checks for the changed behavior. Base it on the selected files and actual edits, for example checking affected dropdowns, keyboard navigation, model/agent selection, settings controls, or mobile/desktop variants.
- Include any skipped diagnostics and why.

Constraints:
- Keep the PR small and reviewable.
- Do not auto-merge.
- Do not modify unrelated files except minimal supporting changes required by selected-file fixes.
- Do not run broad formatting.
- Do not fix diagnostics outside the selected files.
- Do not edit `CHANGELOG.md`, package versions, or release metadata. This is internal maintenance with no user-facing change.
- Leave the batch's run directory intact after creating the PR. `next-batch` prints its location. That directory is both the handoff for the review follow-up task and the claim that stops another batch, including the anti-slop pipeline, from touching the same files. Deleting it early lets a parallel batch collide with this PR. Never delete it by hand; use `bun run doctor -- release --run <run-id>`.
- If you stop before creating a PR for any reason, release the claim with `bun run doctor -- release --run <run-id>` so the files return to the pool.
