# Reference picker

The picker for GitHub issues and pull requests and Linear issues, used by the
composer (any number of items, attached together) and by New Worktree (one
item, which names the branch). The issues and PRs board
(`components/sourceBoard`) lists the same items on a full page and acts on
them; see *Board* below. Extensions are not inside it: they draw their
own search in an iframe and attach through `host.attach`, so the + menu lists
every source, GitHub, Linear and each extension, as its own row.

## Files

| File | Owns |
| --- | --- |
| `useReferenceBrowser.ts` | The state both the picker and the board read: GitHub tab and filter, search, highlight, the previewed item and its details, arrow and Ctrl+N/P keys. |
| `ReferenceBrowser.tsx` | The parts both lay out: tabs (GitHub only), search filling the row with the filter as one menu beside it (32 px, like the tabs), the list with its loading, failure, empty and not-connected states. |
| `ReferencePickerDialog.tsx` | The picker around them: checked items, the diff switch, Enter/Shift+Enter, confirm. Desktop shows the list and a preview side by side; mobile opens the preview in place of the list. |
| `ReferencePickerRow.tsx`, `ReferencePreview.tsx` | What a row and the preview show. State colours are the theme's PR tokens through the sidebar's rule (`lib/source-control/prVisualState.ts`). |
| `referenceSources.ts` | Which cache a list or a Linear preview comes from, and its key. |
| `referenceCache.ts` | Stale-while-revalidate lists and values. |
| `resolveComposerReferences.ts`, `useAttachReferences.ts` | Turning confirmed items into composer chips with their full context. |
| `referencePickerItems.ts` | Item union, keys, state looks, filters. |

## GitLab projects

The GitHub source is the project's repository source. When the project's read
context is GitLab's (`useGitHubReadContext` prefers GitHub, then GitLab), the
same tabs list its issues and merge requests (`gitlabReferences.ts`): pages
come from the provider-neutral `issuesList` / `changeRequestsList` (the same
state and whose-items filter as GitHub, page number as cursor), the preview from `issueComments` /
`changeRequestContext`, and items carry `provider: 'gitlab'` so rows read `!N`
for a merge request. GitLab gives no close reason, so a closed issue reads as
done. The + menu, the picker title and New Worktree name GitLab for such a
project.

## Lists and the cache

- A list is cached per key `[runtime, account or Linear workspace, project, kind, filter, search text]`. Switching tabs or filters, or reopening the picker, shows the cached list at once; one older than 60 s refreshes in the background and is replaced when the answer lands.
- A failed first load is an `error` state with Retry. A failed refresh keeps the shown items and shows the error above them. Failure never becomes an empty list.
- Every first-page request bumps the key's generation; an answer or a later page from an older generation is dropped.
- Keys someone is subscribed to are never evicted; the 40-entry bound is a soft target.
- GitHub pages come from `GET /api/source-control/github/references` (server: `packages/web/server/lib/github/DOCUMENTATION.md`), read with the project's GitHub read context (`useGitHubReadContext`): the account its binding names, or the current github.com account for a repository nobody bound. List and preview cache keys carry that account. Linear lists use `linear.issuesList` with the filter's status, whose issues (`assignee=me` or `created`) and priority, combined; picking in the filter menu keeps it open.

- An open PR turns orange on failed checks or a conflict, as in the sidebar. A page does not carry that (mergeability alone made a 30-PR page about three times slower), so once the list shows, `useGitHubPullStatuses` asks `references/status` for the open PRs it lists, a page per request, and the rows and the preview recolour when it lands. The preview's Checks line reads the same answer, so its text and the colour never disagree. Statuses are cached per PR and head commit. Until a status arrives, or when it fails, a PR reads as open. GitLab projects ask nothing and keep their state colour.

## Preview and attach

- The preview shows the list item at once and asks for the rest of the item the highlight rests on (250 ms after it stops moving): GitHub comments, and a PR's size, review and newest commits, from `references/detail` with the same read context (a GitLab merge request's pipeline, commits and verdicts come with its detail, read with `includeTimeline`); a Linear issue's description and comments from `linear.issueGet`. Both land in value caches: going back to an item shows what was already read at once, without waiting out the 250 ms, and attaching a previewed Linear issue reuses the answer.
- A PR's thread is its activity (`referenceTimeline.ts`): comments, review verdicts and commits by time, commits in a row grouped, so a review reads next to the commits it answered. Comments made at the same moment as a commit come first.
- Descriptions and comments render with `allowRawHtml`, the Files preview's allowlist: GitHub's `<img>` screenshots, tables and `<details>` show, scripts, styles and author classes are dropped. An image with both `width` and `height` scales by its ratio. The Linear panel and the Git view's PR section render GitHub and Linear text the same way.
- Attaching reads the full context the agent receives through the provider-neutral source-control reads (`issueGet` + `issueComments`, `changeRequestContext`) with the same read context: issue with all comments, PR context with the diff only when "Also send the diff" is checked for that PR, Linear issue with comments. Chips and context parts use the provider-neutral kinds `repository-issue` and `change-request` (with its provider). Each item resolves on its own; the ones that fail stay checked in the picker with the reason, the rest attach.
- The composer keeps attached items as a list (`chat/composer/composerReferences.ts`). The same item attached again replaces its chip in place.

## Keyboard

Arrows and Ctrl+N/P move the highlight from the search field. Enter attaches the
checked items, or the highlighted one when nothing is checked; Shift+Enter
checks the highlighted item. Double-click attaches a row.

## Runtimes

Web, desktop and hosted mobile use it as above; Capacitor mobile gets the
in-place preview layout. VS Code never opens it: the composer offers only files
there.

## Board

`components/sourceBoard` is a full page over the chat area, opened from the
sidebar header (desktop and web; not VS Code, not the phone shell yet). It
uses `useReferenceBrowser` and the shared parts without checkboxes; the
preview's footer holds actions instead of what the agent gets.

- The board keeps its own project, tab and Linear team per runtime
  (`stores/useSourceBoardStore.ts`). Switching them never changes the app's
  selected project.
- The repository tab is the project's host only: GitHub or GitLab, whichever
  `useRepositoryHostProvider` names; a project with no supported remote shows
  Linear alone.
- The toolbar is one row: the scope (a project picker with icons and search,
  like the draft composer's; a team picker on Linear, with the workspace in the
  same menu when there is more than one), one switch for Issues, Pull requests
  and Linear, then the search and the filter. The preview's footer is one row:
  where a Linear issue starts and a PR's merge or ready on the left, New session
  and the worktree action on the right, the main one last.
- Linear lists one team or all. An issue starts in its team's mapped project
  (`resolveLinearMappedProjectPath`), else the mapping's default, else the
  board's project; the user can pick another for that issue. Its state pill
  in the preview opens the team's states (`SourceBoardLinearStatus`). Linear has no other
  browsing surface: a linked Linear issue in the work-status panel opens the
  board searched for it (`useSourceBoardStore.focusLinearIssue`).
- `toggle_source_board` (`mod+k b`) opens and closes the board; the command
  palette lists it too.
- Actions: start in a worktree (New Worktree opens with the item chosen,
  `initialSelection`), a new session in the project with the item attached,
  and for a PR its Changes (`usePullRequestSelectionStore.requestDiff` hands the
  PR to the diff view's PR scope), Walkthrough, Merge (asks first, with the
  remembered merge method) and Ready for review. Changes and Walkthrough open
  in the folder the app shows when it belongs to the project, else in a new
  draft of the project.

