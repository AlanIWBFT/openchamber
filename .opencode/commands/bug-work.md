---
description: Pick verified bugs and fix them — "шо в нас по ерорам?" starter
---

Focus, if any: $ARGUMENTS

The maintainer wants to fix real bugs without touching the GitHub UI. Run this as a conversation, not a report:

1. **Gather the menu.** Two sources, both verified:
   - the local backlog at `.opencode/plans/issue-triage/fix-backlog.md` — LIVE bugs with current file:line anchors, grouped by area, data-loss first;
   - `gh issue list -R openchamber/openchamber --state open --label root-cause:found --json number,title,labels` for anything newer than the backlog file.
2. **Propose 3–5 candidates**, one line each: the user-visible symptom, the traced mechanism (file:line), and rough size. Order by severity: data-loss and regression first, then whatever matches the maintainer's focus (an area, a platform, "щось маленьке"). Ask which to take — batches of related small fixes in one area are welcome.
3. **Verify before fixing.** Anchors age: confirm the cited mechanism still exists on current main (main moves fast — see the backlog header). If it is gone, say so and mark the issue for a fixed-close instead of fixing air.
4. **Fix properly.** Follow AGENTS.md instruction order (matching skills — sync bugs demand `sync-state-invariants`, hot paths `performance-engineering`); minimal fix plus a regression test per local precedent; focused validation.
5. **Close the loop.** When the maintainer confirms and asks to commit, include `fixes #<N>` per bug in the commit message so GitHub closes the issues automatically. Update the backlog file: remove the fixed entries. Never commit or push without being asked.
