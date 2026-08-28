---
name: triage-issues
description: Load when asked to triage, clean up, batch-process, or work through the issue backlog — covers the mechanical sweep (stale-fixed, dead needs-info, duplicates), fan-out assessment, and approved batch actions.
---

Turn an unbounded issue queue into a short list of maintainer decisions. Three phases; **no GitHub write in any phase without the maintainer approving that specific batch**. Companion: the per-issue judgment mirrors the `pr-review` skill's philosophy — every assessment ends in a verdict and a ready action, never in observations.

## Verdicts

- **FIX-READY** — a real bug with a traced mechanism (`root-cause:found` from intake, or traced during this sweep). Ready action: a one-line fix-backlog entry (file:line, mechanism, suggested fix shape) — these accumulate into the sweep's fix list for agents to implement.
- **NEEDS-REPORTER** — cannot proceed without the reporter. Ready action: the single unanswerable question, posted once; the issue then lives on a clock (close as stale after ~30 days of silence).
- **CLOSE-FIXED** — behavior fixed by a merged change. Ready action: close comment naming the commit/PR and the release that carries it.
- **CLOSE-DUPLICATE** — same failure as an existing issue. Keep the issue with the better evidence, close the other naming it.
- **CLOSE-DECLINE** — a feature or behavior the product should not take (the `pr-review` skill's whim/scope grounds apply). Ready action: honest close comment; where a real ache underlies it, salvage per the pr-review skill's rule.
- **FEATURE-DECISION** — a plausible feature only the maintainer can judge. Ready action: the product question in one line plus drafted comments for both answers. These go to the maintainer as a numbered list, like the PR triage's Product fit block.

## Phase 1 — Mechanical sweep

Fetch all open issues with `gh issue list --limit` above the real count. Bucket cheaply before any deep reading:

| Bucket | Signal | Likely verdict |
|---|---|---|
| Stale-fixed | references code/behavior changed by merged PRs; CHANGELOG `[Unreleased]`/recent releases mention the symptom | CLOSE-FIXED (verify before closing) |
| Dead needs-info | `needs-info` with no reporter reply > 30 days | close as stale |
| Duplicate clusters | title/error-string similarity across open issues | CLOSE-DUPLICATE |
| Feature wishes | `enhancement` | FEATURE-DECISION or CLOSE-DECLINE |
| Traced bugs | `root-cause:found` | FIX-READY candidates, verify the trace still applies |

Weigh trusted community reviewers' comments (see the `triage-prs` skill's rule — same names, same weight) and the intake bot's "For the maintainer" lines as strong signals. Deliver the sweep as one report and stop for approval.

## Phase 2 — Approved batch actions

Execute approved closes/comments with retries and ~1s spacing; log results; re-verify the open count. Closes use `--reason "completed"` for fixed and `--reason "not planned"` for declines/duplicates/stale.

## Phase 3 — Assessment fan-out

For the surviving pool, fan out subagents (~15 issues each) that read the issue, its comments, and the relevant code, and return per-issue verdict blocks. Consolidate grouped by verdict, FEATURE-DECISION questions in a numbered block for the maintainer, FIX-READY entries as an ordered fix backlog. Stop for approval; then act, and hand the approved fix backlog to implementation agents in dependency-safe batches.

## Message templates

**stale-close (dead needs-info)**
> Closing as stale: the requested details never arrived, and without them this can't be reproduced. If you hit it again on a current version, a fresh report with the missing details is welcome.

**fixed-close**
> This was fixed by [ref] and ships in [release/next release]. Closing — if the problem persists there, comment and it will be reopened.

**duplicate-close**
> Closing as a duplicate of #[N], which tracks the same failure[: one clause on what this report added, if anything]. Follow that issue for updates.

**decline-close**
> Thanks — closing this one: [honest one-sentence reason grounded in product direction or maintenance cost]. [If a real ache underlies it: the welcome shape of a future change.]
