# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Contains `StaticToolRow`, the compact one-line row of a navigation tool.
    The file keeps the name of the grouped Activity block it used to hold.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change compact `skill` rows, edit here.
  - `ExplorationToolGroup.tsx` renders cross-message Exploration groups.

- `ToolPart.tsx`
  - Renders expandable tool rows (read/shell/edit/write/question/subagent + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.
  - A subagent call is an ordinary tool row, rendered through `SubagentToolPartContent`: shine and a live duration while it runs, the final duration (red on failure) once settled, and an open action that shows the child session. Expanded, it shows the prompt and the result. The row never reads the child session's messages; the child's own chat is where its work is shown.
  - While the child runs, foreground or background, the row has a stop action. OpenCode 2.0.23 has no route that cancels a subagent job; interrupting the child ends the job as cancelled, which the agent reads as a failed subagent and tends to restart. `opencodeClient.stopSubagent` therefore first admits a non-resuming synthetic note (`subagentCancellationNote` in `@/lib/opencode/subagent-run`) that explains the cancellation as the user's stop without forbidding the work, then calls the local `session.stop` for the child to stop both its turn and its persistent commands. Note delivery or command cleanup failure is reported to the caller. A foreground call the note names reads `stopped` instead of failed (`toStoppedSubagentPart`). Drop the note once OpenCode reports a user cancel itself.

- `taskToolModel.ts`
  - Owns subagent output preparation and child identity parsing. `ToolPart.tsx` resolves the call's child identity.
  - A subagent's `state.metadata.sessionID` is the preferred child identity from progress/result updates. Legacy part metadata and output IDs remain readable, then a non-empty `state.input.sessionID` identifies a resumed child when those IDs are absent.
  - If none of those sources names a child, a running call may infer one from child sessions created at or after the call start. Candidates must belong to the parent, match the requested agent when the session has one, and remain unclaimed by sibling calls. A unique candidate is accepted; when several remain, the call description must uniquely match the child title. Ambiguous calls stay unlinked. Inference never pairs children by sibling order or status.
  - Child inference is presentation-only, never a lifecycle or recovery authority.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by `ProgressiveGroup.tsx`, `ToolPart.tsx`, and `ToolOutputDialog.tsx`.
  - Takes an optional extension rule (below) whose `icon` wins when the sprite carries it.

- Tool names, per-tool input/metadata fields, and the row description are owned by `@/lib/opencode/tools`. Branch on its predicates (`isShellTool`, `isSubagentTool`, `isFileChangeTool`, ...) instead of comparing tool names here; v2 has no `state.title`, so a row's description comes from `toolDescription(tool, input, metadata)`. Every v2 built-in answers from its own input before its result lands: `patch` from the `*** Update File:` headers of its text until `metadata.files` arrives, `skill` from its `id`, and the `opencode.*` namespace tools (`session_rename`, `session_move`, `models`) from their title, directory or search; `getToolMetadata` resolves a namespaced name by its last segment.

- Extension tool presentations (`contributes.tools` in a guest manifest)
  - The registry is `lib/guests/tool-presentation.ts`: `useGuestToolPresentation(part.tool)` / `resolveGuestToolPresentation` return the first matching rule of an active guest (exact `match` beats a suffix wildcard; first extension wins) or `null`. Rules are compiled once per catalog array; each part does one linear scan.
  - The lookup always gets the **full** tool name OpenCode reported (`mcp.jira.search`); `normalizeToolName` still feeds every built-in switch, so built-in behavior is untouched when there is no rule.
  - Hook points, each falling back to today's code when the rule is `null` or silent on that field: icon (`getToolIcon`), header title (`title` template, else `name`, else `getToolMetadata`), header subtitle (`subtitle` template replaces both the description and the justification text), and the expanded body (`output`: `text` / `code` / `json` / `markdown` / `table`, checked at the top of `renderResultContent` and inside `ToolScrollableTextOutput`; `auto` keeps detection). A `table` whose output is not an array or `{ items: [] }` falls through to detection.
  - `GuestToolTable.tsx` draws the table with the same cell classes the markdown decorator gives assistant tables, capped at 200 rows with a count line.
  - VS Code and mobile mark the guest catalog unsupported, so the registry is empty and nothing changes there.
  - Unified Exec keeps its native output, activity state, and control filtering. Extensions may customize the root command's header and icon, but control calls do not expose input to extension templates, which could otherwise reveal stdin text.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `components/LiveTurnActivity.tsx` (relative to the chat folder)
  - Owns the turn disclosure. `MessageList` enables it whenever the turn has
    visible tools or reasoning; Activity Default selects its initial state.
  - `components/LiveActivityCollapse.tsx` owns the finite height transition;
    `components/liveActivityContext.ts` scopes the final message's non-text
    disclosure without changing message context or tool rendering.
  - `lib/turns/liveActivity.ts` owns final-answer and interruption boundaries
    and the seven-row preview, counting each complete Exploration group once and excluding successfully rendered pages.
  - `lib/turns/liveActivitySummary.ts` derives the report from tool results.

- `HtmlRenderFrame.tsx` and `htmlRender.ts`
  - A completed `openchamber_render` call that OpenChamber accepted (`renderedPage` in `@/lib/opencode/tools`: `metadata.openchamber.ok` and an `html` input) is drawn as the page itself in place of its tool row. A refused or running call keeps its ordinary row.
  - Page inputs use the local `request` wrapper, with precedence over legacy `parameters` and flat fields so persisted calls remain readable.
  - The page loads through `srcdoc` in a frame sandboxed with `allow-scripts allow-forms` and never `allow-same-origin`, so its script runs in an opaque origin with no reach into the app. `buildHtmlRenderDocument` puts a bootstrap first in the page's head: the theme as CSS variables (`htmlRenderTheme`; the agent tool's description in `packages/web/server/lib/agent-tool/runtime.js` lists the same names; `--chart-1` is the theme's accent and `--chart-2` to `--chart-6` a fixed set per light and dark, `CHART_SERIES`, because the theme's syntax colors made near-identical series), a size report, and http(s) link clicks handed to the host, which opens them with `openExternalUrl`. A theme switch is posted to the page instead of rebuilding it, so the page keeps its script state. Messages are accepted only from the frame's own window. A focused frame keeps every key from the app, so the bootstrap passes on a Cmd/Ctrl chord the page left alone (not typed into its own fields, not handled by its script, not the clipboard, select-all or undo chords), and the host replays it as a keydown and keyup on the frame element. The app's shortcut handling then runs as for any key pressed outside a text field, with no list of shortcuts to keep in sync. A chord without Cmd or Ctrl is never replayed. Pages are interactive within themselves (tooltips, tabs, sorting) and cannot send anything to the chat or the agent.
  - The frame fits the reported height between 48 and 1200 px; a taller page scrolls inside it. On a touch screen (`pointer: coarse`) the frame takes the page's full height (`HTML_RENDER_TOUCH_MAX_HEIGHT` only stops a page that grows with its frame), so a page never scrolls inside the chat there: a scrolling frame as tall as the screen left no place to swipe the chat from. The full-screen view builds the page `contained`, which stops its scrolling at the edges without the elastic bounce. A page that fits its frame gets `overflow-y: hidden` from the bootstrap, so a touch that starts on it scrolls the chat instead of bouncing inside the frame (iOS keeps a touch in any document that can scroll). Media is capped at the column width; content still wider scrolls sideways (`overflow-x: auto`, `overscroll-behavior-x: none`), and the tool description asks agents to give a wide table its own scroll box. Only the horizontal bounce is off: `overscroll-behavior-y` stays default, because turning it off would also keep a vertical swipe from reaching the chat. The last height is kept per call, so a row the timeline unmounted comes back at its size.
  - The bootstrap moves a tooltip or popup the page positions itself back inside the frame when it sticks out past an edge (`translate`, so the page's own `transform` still applies). Only absolutely or fixed positioned elements that are partly inside are moved; one wholly outside, wider than the frame, or inside a box that scrolls or clips is left alone. Hover counts as a trigger, because a CSS `:hover` tooltip changes nothing in the DOM. The tool description also asks agents to keep tooltips inside the page.
  - In the mobile layout (`useUIStore.isMobile`) the page has no full screen or download: it is already as wide as the screen.
  - Full screen opens the page in a dialog, inset from its edges and as tall as the page up to the window, past which the page scrolls. Download saves the page with the theme it was viewed in; on Capacitor it goes through the native share sheet, and VS Code shows no download because its bridge has no save route for HTML.
  - VS Code's webview CSP allows inline scripts but no remote ones, and a `srcdoc` page inherits that policy, so the tool description tells agents to draw charts with inline SVG or their own script.
  - A page stays outside Activity whether it is collapsed or expanded. `LiveTurnActivity` collects the turn's pages (`getShownPages`) and `LiveTurnHoistedPagesContext` keeps their rows out of the fold, so an opened fold does not draw them twice. While the turn works, and in a turn that ended without a final answer (stopped, failed), the pages sit right below the fold; once the final answer arrives, the final message draws them above its first answer text.

- `BlockLine.tsx`
  - The vertical connector line left of a collapsible block's body. It is also a click target: clicking it folds/expands the block via its header toggle handler (`onToggle`), or toggles the nearest native `<details>` when no handler is passed (JSON summary sections). Geometry is inline-styled (12px hit strip centered on the 1px line) so it does not depend on compiled Tailwind classes.

## Current important behavior

### Bidirectional prose

Shared chat CSS applies `unicode-bidi: plaintext` to prose blocks, including
nested paragraphs, headings and table cells. Plain user text uses the same
behavior across newlines. The message root does not select one direction for
all its children. Code widgets, diagrams, math and technical references remain
LTR isolates, including their controls.

`markdown/decorate.ts` gives list items and blockquotes `dir="auto"` for marker
and border placement. Paragraphs use CSS rather than their own `dir` attribute,
so their text still participates in that parent direction. Each list item owns
its logical gutter, allowing adjacent Arabic and English items. Inline code
and code widgets have explicit LTR attributes so they do not choose the
containing item's direction. Direction changes preserve source and copy text.

### Turn footer copy and image

The footer under a turn's last assistant message copies and saves the whole
reply: the text parts of every assistant message in the turn, in order, with
tool output and reasoning left out. `MessageList` hands the earlier text to the
last message as `earlierAssistantText`; per-message copy buttons keep copying
only their own text. Earlier messages may be folded or not mounted, so a
reply of more than one text part is drawn by `buildTurnImageExportSource` from
Markdown with the chat's classes and `decorateMarkdown`. A reply of one text
part keeps the copy of what the chat rendered.

### Live Activity disclosure

The chat has one render mode: parts stream in and stay in the order they ran.
The Sorted mode, which folded a turn's work into one block above its answers,
was removed; a stored `chatRenderMode: 'sorted'` reads as Collapsed Activity
(`lib/settings/parsers.ts`, `parseActivityRenderMode`). Expanded and Collapsed
select the default state of the same disclosure. Text-only turns stay inline;
tools, including subagents, and visible reasoning enable the Activity header.
The original rows retain their order and individual controls.

The active turn has its Activity header from the first step. Folded, it shows
only the latest 7 top-level rows, counting a cross-message Exploration as one.
The latest nonempty assistant text is pinned separately below the preview,
excluded from its row budget, and replaced by newer prose. Original turn
grouping remains authoritative even when text is pinned. A muted `+N more...`
control below the header counts earlier rows and opens them all. Hovering the
running header shows the current view (Latest activity or All activity); touch
activation shows it for 1.2 seconds. When the cut moves down, `useActivityRowGlide`
replays the jump as a 220 ms glide of the rows (FLIP, `transform` only, skipped
with reduced motion). The trim stays while the settled fold closes and lifts
when the reader opens it. A final assistant message with `finish: stop`
collapses the earlier messages and the final message's non-text parts, keeping
the answer and its existing footer outside. Intermediate-text summary fallback
and compaction summaries never become final answers. An older turn without a
final answer collapses once a later visible turn has an assistant response;
a queued user message alone is not enough. Hidden user continuations retain
the visible-turn mapping established by `projectTurnRecords`. A notice the
timeline skips that separates a `stop` answer from the next assistant message
opens a turn there (`createNoticeTurnSplitter`), so each answer keeps its own
Activity and stays outside it; a notice between steps of one run does not.

One expansion choice survives completion, idle interruption, resumption,
metadata updates and timeline virtualization. A folded running turn previews
its tail; idle or completed turns close fully; resuming restores the preview.
Opening a running turn mounts its newest messages with no hidden tail. Settled
turns choose the head or tail window from the reader's position; resuming an
expanded turn clears the tail limit while preserving its mounted head.
The disclosure uses a finite 180ms height transition,
respects reduced motion, and delegates end pinning to the existing timeline.
It never calls scroll-to-bottom. Collapsed history does not mount its hidden
message bodies; initial history loads do not animate collapse.
Layout-effect replay after a Suspense hide/reveal must settle the requested
height and retained children even when the expanded target did not change.
Cleanup stops the animation, so a same-target early return can leave a cached
pre-collapse height on the DOM indefinitely. Failed animations also settle;
callbacks from cancelled, superseded animations never settle a newer target.

The virtualizer also adds temporary end padding while compensating prepended
history. `@legendapp/list` stores that padding's CSSOM read-back value (built
in since 3.3.11; it was a Bun patch before): Chromium rounds fractional pixel
strings, so comparing the original input with `style.paddingBottom` could skip
cleanup permanently and leave a phantom tail even when every Activity region is
already zero-height. `scripts/legend-list-padding.test.mjs` checks the
installed version for it. Chat padding and scroll policies do not compensate
for it.

The Bun patch for `@legendapp/list@3.6.0` floors `roundSize` to the device
pixel grid instead of eighth pixels, mirroring upstream LegendApp/legend-list#536.
Rows the list has not measured yet are placed at the average measured height;
with eighth-pixel precision their positions are fractional, the browser rounds
each `scrollTop` correction, and the remainder is lost on every compensation
pass. A history prepend then leaves the reader's row one to two pixels off
(3.3.10 drifted too; the browser harness passed only because its row heights
happened to average to a whole pixel). The patch covers both web entry points
in ESM and CJS. Drop it once upstream ships #536 or an equivalent, and verify
with `bun packages/ui/tests/chat-history-scroll.browser.mjs`, which runs the
prepend scenarios over several row-height profiles for this reason.

The same patch hands out containers in item order while the list's initial
scroll is active, end-aligned included. Upstream reverses them for an
end-aligned start (`renderPriority` in `findAvailableContainers`), so a
freshly opened timeline was in reverse DOM order and the DOM-order pass
(`useDOMOrder`) moved nearly every row about 300 ms after the reveal: each row
restyled, and with an accessibility client on, the transcript re-serialized
(about 40 ms on every session open and switch). Containers render in index
order, so rows are now in DOM order (what screen readers and tab order follow)
from the first paint, and the pass finds nothing to move. Scrolling up still
recycles containers out of order; the pass corrects that as before. The patch
also keeps the pass's own delay: it treats the list's mount as activity, so a
pass that does have work waits for 500 ms of quiet instead of landing in the
opening reveal. `scripts/legend-list-dom-order.test.mjs` runs the installed
bundles' allocation and timer code for both.

The header retains its report when expanded and has no hover background. Its
left inset matches the tool rows. Diff deletions use the ASCII hyphen.
The header reports five categories: changed files, codebase
exploration, commands, web research, and subagents. Narrow chat columns only
show file changes and any running-command indicator. Exploration and research are flags, not synthetic counts.
Subagents count distinct child session IDs; commands count calls, not shell
subcommands. Unknown tools and administrative tools stay in the disclosure
without a guessed summary category.

Unified Exec commands count their `exec_command` roots, never their polling,
stdin, or termination controls. A final answer still collapses the outer
Activity while root `processRunning` metadata keeps a running-command count
visible in its header. Updated root metadata clears that count on exit;
finishing the assistant turn does not end a background command. Expanded
Activity retains the local exploration groups and command controls.

Activity and finished-turn file reporting include Script child calls through
`lib/opencode/tool-activity.ts`. This projection reads reporting fields only,
not Script source, output transcripts or attachment bodies. Message preview-URL
discovery checks a Script's own output before its visible child outputs and uses
the latest exec preview; it stops at the first matching URL.

File statistics come exclusively from successful edit/write/patch tool
results, not user-message summary diffs or the current workspace Git diff.
Unique normalized paths determine file count; renames preserve identities.
Line totals sum performed edits, including lines later removed by another
call. Per-file patches/counts take precedence over a whole-call patch; the two
representations are never added together. Missing or truncated diffs suppress
the line total rather than presenting a partial total as complete. Write input
content is not evidence of added lines. Repeated records of one call count once.

The completed-turn file pills under the final answer (the "show changed files"
setting) use the tool-result file identities, in first-touch order, with paths
as the tools reported them (v2 assistant messages carry no working directory).
Line counts come from each call's patch; a file with no recoverable counts
shows its name alone. Every pill opens the turn diff: OpenCode 2 computes it on
request (`GET /api/session/:id/diff`, `DiffView`'s "Last turn" scope) from the
turn's start and end snapshots, merged per file, so it also covers a `write`
result and the edits a `subagent` made in its child session, which the pills
themselves cannot list. Past four pills the rest wait behind one `+N` pill
that reveals them in the row; the same pill then hides them again. The list is projected once the last assistant message
finished with `stop`, so no tool patch is parsed while the turn streams.

### Message parts

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface. Link text goes through the same inline
  renderer, so raw HTML inside `[...]` stays text too. Only the Files
  Markdown preview opts into rendering raw HTML (`allowRawHtml`, see
  `components/views/files/DOCUMENTATION.md`). Safe custom application links go through the
  app-link confirmation flow in every supported renderer, including VS Code.
- File references become links only once the file is confirmed
  (`MarkdownRendererImpl` `useFileReferenceInteractions`): inline code, links
  and path-like tokens inside code blocks are probed through the bounded,
  cached stat queue after the message settles (never while it streams, never
  on mobile), and each pass writes all its links at once. Inside a code block
  nothing is written for a token that leads nowhere, so code full of
  `console.log` and `this.state` stays plain text with no DOM change; a real
  file's token gets its span and link a moment after the message shows.
- Assistant images appear where the text puts them. The Markdown renderer
  draws assistant image syntax as a label, the shared image icon and the file
  name, and never loads an image itself (`label` mode in `markdownCore.ts`);
  tool and simple Markdown keep their own image rendering. A label for a
  workspace-local or embedded PNG/JPEG/GIF/WebP image outside a link carries
  its source (`data-openchamber-markdown-image-source`). Once the text part
  settles (`time.end`), `markdown/inlineMarkdownImages.ts` replaces each such
  label with the picture, at most 30rem wide and tall, in a bordered frame.
  A paragraph made only of two or more images becomes one row of equal height
  that spans the text width (`arrangeImageRow`): each image grows with its
  width-to-height ratio, the shared height stops at 30rem or the smallest
  image's natural height, and below 8rem the row wraps. A label loads only when
  it nears the viewport, so mounted history reads no image files, and the
  picture replaces the label only after it decoded, so the row grows once.
  An image that is missing, too large or fails validation keeps its label.
  Remote images never load: they stay links to themselves (see
  `MarkdownImageMode`), so a model or a fetched page cannot learn when the
  user read the message. A click opens the shared attachment preview overlay
  with every drawn image of the message as its gallery. Copying a selection
  writes `![name](source)`, never the authenticated asset URL.
  In server-backed runtimes, the first label of a part to near the viewport
  prepares all of that part's local images (at most 12) in one request to the
  grant route, then loads them through the authenticated `/api/fs/raw` asset
  route; the preview prepares again, so an expired grant is renewed. Embedded
  images are validated in the browser and limited to 10 MiB. VS Code loads
  workspace-contained images through its local filesystem bridge and never
  calls the grant route; OpenCode temporary-directory images remain
  unsupported there. Workspace-external images receive the existing
  path-bound `outsideFileGrant` only when the server verifies the exact source
  in the owning assistant message and the real file is inside OpenCode's
  dedicated temporary directory.
- Consecutive built-in `read`, `glob`, `grep`, and `list` calls render in one collapsible **Exploration** group. Groups may cross assistant messages in the same user turn, but visible text, visible reasoning, every other tool, and namespaced custom tools end the group.
- The group title is state-independent and its localized summary reports non-zero search (`glob`/`grep`/`list`) and read counts. Its disclosure icon and content rail follow the Reasoning block pattern.
- Script child calls use the same `ExplorationDisclosure` within the Script. Groups end at another tool or the Script boundary; their first child's identity anchors the expansion key in the message owner's expansion memory. Child cards retain their full results and their own expansion choices.
- Read classification accepts the official V2 `Read file`/`Read directory` output header and retained V1 display metadata/tags. The shared output parser removes the V2 header without treating literal `<content>` or `<entries>` in file contents as V1 wrappers.
- Exploration counts and rows include active calls, explicit error/cancellation terminal states, or successful calls with an authoritative valid end time, preventing partial sync state from producing an empty expandable group without hiding failures.
- Activity aggregates Exploration groups before applying its collapsed recent-row preview, so a group is never split at the preview boundary.
- Inside an expanded Exploration group, `read`, `glob`, `grep`, and `list` all use the standard expandable `ToolPart` card. A completed directory read keeps that card but switches its leading icon and localized title to the directory presentation, suppresses the secondary file icon, and shows the relative directory path only in the card header. Directory display paths without `/` gain a trailing `/` (`.` becomes `./`); input and output values are unchanged. Read output is normalized through the shared tagged-output parser and rendered as multiline text, so file contents and directory entries do not use special navigation rows. Image/PDF attachments continue through the shared attachment renderer.
- Outside Exploration groups, `read` also uses the standard expandable card; only `skill` remains a static navigation row. Historical Todo calls remain visible through the generic tool renderer; OpenCode 2 has no live model Todo list. Every other tool remains **expandable**.
- The managed `openchamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- Selecting a JSON summary, tree, or raw view saves that mode in the persisted UI settings. New and refreshed JSON tool outputs read the saved mode across sessions; missing or invalid preferences use Summary.
- Unified Exec reuses the Shell presentation: `exec_command` is the visible root card, while successful `poll_exec`, `write_stdin`, and `terminate_exec` controls are omitted from Activity and Script children. Follow-up failures remain visible, with `chars` removed from their input presentation. Script source and script output keep their normal rendering. `poll_exec` is the only polling operation; `write_stdin` requires non-empty characters or explicit EOF.
- A completed `exec_command` can still represent a running execution. Its root card follows OpenCode Desktop's authority rules: server metadata alone drives command status and timing, `sessionExposed` gates live and completed duration, and fast commands that never expose an execution ID show no completion timer. A persistent lane may keep its shell alive after the command completes, but that does not keep the card active. `laneID`, `shellGeneration`, and `shellReused` are observational metadata; `processRunning` remains the sole command-activity authority. OpenCode guarantees that `metadata.output` is a control-sequence-free transcript observed from the shared lane while the framed execution is active, not that every byte was causally produced by that command. OpenChamber normalizes line endings and renders the server transcript without inferring process ownership. Output emitted while no execution is active is discarded; unsupported work that survives a done frame may interleave with a later execution, and the model owns its interpretation and lifecycle. A completed execution's remaining buffered transcript is delivered and consumed by the call that reports `running=false`; later `poll_exec` calls report completion without replaying it. While an execution is running, unread output stays buffered and only the middle beyond the 256KB buffer is dropped once, with an explicit omitted-bytes marker.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. Patches over 256 KiB or 2,000 lines skip rich parsing and use a bounded plain-text preview; navigation keeps the original patch. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- The `@pierre/diffs` stack is knowingly unprotected against the JS/TS `template-call` backtracking that OOM'd the renderer in openchamber/openchamber#2587. Our own markdown Shiki worker sanitizes every grammar it loads (`@/lib/shiki/sanitizeTemplateCallGrammar`), but the diff worker pool runs `preferredHighlighter: 'shiki-wasm'` (`DiffWorkerProvider.tsx`) and resolves its languages by id through `@pierre/diffs`' own registry — `langs` accepts `SupportedLanguages` strings only, so there is no seam to hand it a pre-sanitized `LanguageRegistration`. A pathological template literal inside a rendered diff can therefore still hang that pool's Oniguruma engine. The available levers are upstream (a `langs` overload accepting grammar objects) or switching that pool to the JS regex engine; neither is done.
- OpenCode 2 Code Mode arrives as one tool, `execute`, whose input is a short
  JS script (`input.code`) calling the MCP and integration tools as functions.
  The row is named **Script** (`toolHelpers.ts`), uses the `braces` icon, and is
  described by `metadata.toolCalls`: the called tool names deduplicated in
  first-seen order with a `×N` repeat count, at most four named and the rest
  counted as `+N more`. That is the `tools` description kind in
  `@/lib/opencode/tools`; while the script is running, or if it called nothing,
  the row falls back to the script's first line, capped like a shell command.
  The expanded body replaces the generic input preview with the script as
  highlighted JavaScript, then complete child tool cards, then the normal output
  section. `lib/opencode/script.ts` projects those cards from the parent's metadata;
  they are not independent transcript parts or model calls. Results, attachments,
  failures and command previews use the normal tool renderer. Older records without
  child IDs or timing keep their compact name/argument rows. Each mounted Script
  retains only its current child projections, reusing unchanged child references
  during preview updates. Child expansion uses the message owner's existing expansion
  memory. Tools and Script children expand on click; the former default-expanded
  Shell/edit settings no longer apply. Historical tool content is fetched on demand.
  `metadata.truncated` adds a plain note with `metadata.outputPath` as
  text: the app has no open-file affordance for a path outside the project.
  The status pill says `running a script`, or `calling <tool>` once
  `metadata.toolCalls` names one (`hooks/useAssistantStatus.ts`).
- Running `shell` output falls back to `state.metadata.output` until canonical `state.output` arrives. Its output viewport grows with the content up to `46vh`, then scrolls and follows new output until the user scrolls up; following resumes when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- A background `shell` call (`background: true`, or moved to the background mid-run) settles at once with `metadata.status: "running"` and a `shellID`; its text is a notice plus an instruction for the model. `ToolPart` renders it through `BackgroundShellToolPartContent`, which rebuilds the part from the command's real state (`backgroundShellPart.ts`) so the row keeps the ordinary shell look collapsed and expanded: while `sync/background-shells.ts` lists the command it is a running shell with a live timer from the call start and an `in background` label, and its expanded output is read from `/api/shell/:id/output` once a second, only while expanded (`useBackgroundShellOutput.ts`, starting from the last 64 KiB). Once OpenCode appends the command's completion (a `synthetic` message with `source: "shell"`, see `@/lib/opencode/background-shell`) the row is a finished or failed shell ending at that message, with its real output; the completion message itself stays hidden from the timeline. While it runs the row has a stop action. OpenCode 2.0.19 has no route that cancels a background job, and `shell.remove` reports the command to the agent as an error (`Shell.NotFoundError`, "nothing ran"), after which agents relaunch it; `opencodeClient.stopBackgroundShells` therefore first admits one non-resuming synthetic note (`shellCancellationNote`) for the commands of one session it stops, which explains the coming errors as the user's stop without forbidding the commands, and removes the shells together only once the note is in. The note stays out of the timeline (no context metadata); its `openchamberShellCancellation` metadata (`shellIDs`, or a single `shellID` in notes written before stops were grouped) makes each named row read "stopped" instead of failed. Drop the note once OpenCode reports a cancel itself. The composer's `BackgroundShellsStrip` offers the same stop for every running command of the session and its subagents (see `composer/DOCUMENTATION.md`). Between the two, or before the list was read, the row shows the notice without the model instruction and no duration. The user moves a foreground command (or a subagent the turn waits on) there with `session.background`, which backgrounds all of the session's blocking work at once: the action sits in the status chip above the composer and in the scroll-to-bottom pill (`components/BackgroundWorkButton.tsx`, a sibling of the pill's scroll button), shown only while `useAssistantStatus` reports `working.canBackground` (including a running shell or subagent inside Code Mode `execute`: its live `metadata.toolCalls` list or child progress, a `shellID` or a `sessionID` with `status: "running"`, identifies the blocking job), and on the customizable `background_session_work` shortcut (default `mod+shift+b`; not the TUI's `ctrl+b`, which the composer's macOS emacs keymap uses to move the caret and which is `mod+b` elsewhere). The row then turns into the background row above.
- A `subagent` call that went to the background (`background: true`, or moved there with `session.background`) settles at once with `metadata.status: "running"` and the child in `metadata.sessionID`. `SubagentToolPartContent` rebuilds it from the child (`backgroundSubagentPart.ts`): running while the child session is active in `global-session-status`, then finished, failed or stopped from the report OpenCode appends (`findSubagentRun`), with the `in background` header label while it runs, `stopped` after a cancel, and the stop action described for subagent rows above. `ChatContainer` drops that report from the timeline (`keepCommandSubagentReports`), so the subagent stays where it was started instead of reappearing as a new turn at the end. Only reports of `subagent: true` commands, which have no call row, still render as their own `TimelineNotice` turn, and only when the child started inside the loaded history; any other report (a call not loaded yet, an unknown child) stays out of the chat and is reachable from the session's subagent list, so loading older history never makes the chat shift.
- The result of a session the agent dispatched with `returnResult` arrives as a `synthetic` message with `source: "openchamber-session"` (`@/lib/opencode/dispatched-session`, delivered by the server's `lib/dispatch-results`). It is a background report like a subagent run (`isBackgroundReportEntry`): it opens a turn, so the woken agent's reply renders below it, and a fork after an answer cuts before it. `TimelineNotice` renders it as one collapsed row, `Session finished: <title>` (failed / stopped variants carry the status icon), that opens to the answer as Markdown with an `Open session` action going through `openSessionLink`.
- Reasoning streaming presentation derives from the live stream phase (`streaming`/`cooldown`), never from missing persisted timing: a cached part without `time.end` is not live, and a part whose `time.end` is set never streams (issue #2020).
- Assistant text parts carry the same part-finalization gate (`assistantTextVisibility.ts`): the block-level reveal (`lib/streamTextCommit.ts`) holds a still-growing part's unfinished block, and the reply takes new text at most every 400 ms, while a part sealed with `time.end` renders in full immediately — including while the turn stays blocked on a pending question or permission ask (#3277).

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Skill in compact mode":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles `skill` in `StaticToolRow`.
3. Keep all other tool header/output behavior in `ToolPart.tsx`.
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: `skill` has a purpose-built compact navigation interaction; all other tools need observable input and output.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove a tool name from `STATIC_TOOL_NAMES` only when it has a reliable purpose-built compact interaction
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate with Activity Default set to Expanded and to Collapsed.

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Attachment citations: the composer writes `[name.png]` into the text for each
  pasted or picked file. `UserTextPart` gets the message's file names and draws
  each citation of one of them as an inline chip with its file-type icon. The
  Markdown path rewrites it to a `#openchamber-attachment:` link
  (`lib/messages/inlineMessageLinks.ts`) that `markdownCore` renders as a span
  and `decorate.ts` gives its icon; the plain-text path builds the same chip
  directly. Brackets around anything that is not an attachment stay text.
  A known skill (`$name`, or `/name` in messages sent before skills moved to
  `$`) renders as the same chip with the book icon and still opens the skill
  file on click. The composer draws both chips too
  (`composer/editor/composerLanguage.ts`).
- User-attached context (inline code comments, terminal selections, browser
  annotations, PR comments/checks): `UserContextPart.tsx`. `UserTextPart`
  routes to it when the part's metadata carries an `openchamberContext`
  payload (see `lib/messages/contextParts.ts`, which owns both the send-time
  builder and the read-back parser). Linked source-control issues/change
  requests and Linear issues are instead converted to link file-parts in
  `normalizeUserDisplayParts.ts`. Legacy pre-metadata messages still render
  via text sniffing (`<terminal_context>` blocks, `GitHub issue context (JSON)`
  and `Linear issue context (JSON)` prefixes).
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`, `GuestToolTable.tsx`
- Reasoning: `ReasoningPart.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
