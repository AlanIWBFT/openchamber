# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change Exploration grouping or compact `skill` rows, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (`read`, bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface. Safe custom application links go through the
  app-link confirmation flow in every supported renderer, including VS Code.
- Final assistant Markdown rendering is independent from image gallery
  extraction: gallery presence never changes the chat body. Assistant image
  syntax consistently renders as a shared image icon followed by its filename,
  without loading the image in the body; tool and simple Markdown retain normal
  inline image rendering. The gallery separately collects HTTP(S), embedded, and workspace-local
  PNG/JPEG/GIF/WebP image candidates into one 100px thumbnail gallery in the
  message-completion area after all message text and above the turn's changed
  files. Each muted filename caption includes the shared image-file icon.
  HTTP(S) images keep their browser URL. Embedded and workspace-local images
  are limited to 10 MiB and validated as PNG/JPEG/GIF/WebP. Chat Markdown uses
  the assistant image-label policy without gallery-specific link rewriting,
  completion-state switching, or hidden placeholders. A
  completed assistant message hydrates at most 12 unique image candidates,
  including persisted text parts that omit their optional part-level end time.
  In server-backed runtimes, a gallery approaching the viewport prepares all
  local candidates in one message-level request, then reuses the authenticated
  `/api/fs/raw` asset route. Each URL loads only when its thumbnail approaches
  the viewport. VS Code instead loads workspace-contained images through its
  local filesystem bridge and never calls the server grant route; OpenCode
  temporary-directory images remain unsupported there. Mounted historical
  messages therefore do not eagerly read every image.
  Gallery clicks do not introduce or alter preview chrome: desktop and mobile
  both reuse the pre-existing attachment image preview overlay.
  Workspace-external images receive the existing path-bound `outsideFileGrant`
  only when the server verifies the exact source in the owning assistant
  message and the real file is inside OpenCode's dedicated temporary directory.
- Consecutive built-in `read`, `glob`, `grep`, and `list` calls render in one collapsible **Exploration** group in both live and sorted modes. Groups may cross assistant messages in the same user turn, but visible text, visible reasoning, every other tool, and namespaced custom tools end the group.
- The group title is state-independent and its localized summary reports non-zero search (`glob`/`grep`/`list`) and read counts. Its disclosure icon and content rail follow the Reasoning block pattern.
- Exploration counts and rows include active calls, explicit error/cancellation terminal states, or successful calls with an authoritative valid end time, preventing partial sync state from producing an empty expandable group without hiding failures.
- Sorted Activity aggregates Exploration groups before applying its collapsed recent-row preview, so a group is never split at the preview boundary.
- Inside an expanded Exploration group, `read`, `glob`, `grep`, and `list` all use the standard expandable `ToolPart` card. A completed directory read keeps that card but switches its leading icon and localized title to the directory presentation, suppresses the secondary file icon, and shows the relative directory path only in the card header. Directory display paths without `/` gain a trailing `/` (`.` becomes `./`); input and output values are unchanged. Read output is normalized through the shared tagged-output parser and rendered as multiline text, so file contents and directory entries do not use special navigation rows. Image/PDF attachments continue through the shared attachment renderer.
- Outside Exploration groups, `read` also uses the standard expandable card; only `skill` remains a static navigation row. Non-failing built-in `todowrite` calls are omitted from session rendering because authoritative `todo.updated` events update the visible Todo List independently; failed or cancelled updates remain visible. Every other tool remains **expandable**.
- The managed `openchamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- Unified Exec reuses the Shell presentation: `exec_command` is the visible root card, while successful `write_stdin` and `terminate_exec` controls are omitted from live, sorted Activity, and Task-summary projections. Follow-up failures remain visible, and stdin text must never be rendered. A pending `write_stdin` has incomplete input, so operation-specific status is derived only after its running state arrives.
- A completed `exec_command` can still represent a running process. Its root card follows OpenCode Desktop's authority rules: server metadata alone drives process status and timing, `sessionExposed` gates live and completed duration, and fast commands that never expose a process session show no completion timer. OpenCode guarantees that `metadata.output` is a control-sequence-free UI transcript; OpenChamber only normalizes its line endings.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- The `@pierre/diffs` stack is knowingly unprotected against the JS/TS `template-call` backtracking that OOM'd the renderer in openchamber/openchamber#2587. Our own markdown Shiki worker sanitizes every grammar it loads (`@/lib/shiki/sanitizeTemplateCallGrammar`), but the diff worker pool runs `preferredHighlighter: 'shiki-wasm'` (`DiffWorkerProvider.tsx`) and resolves its languages by id through `@pierre/diffs`' own registry — `langs` accepts `SupportedLanguages` strings only, so there is no seam to hand it a pre-sanitized `LanguageRegistration`. A pathological template literal inside a rendered diff can therefore still hang that pool's Oniguruma engine. The available levers are upstream (a `langs` overload accepting grammar objects) or switching that pool to the JS regex engine; neither is done.
- Running bash output falls back to `state.metadata.output` until canonical `state.output` arrives. Its output viewport grows with the content up to `46vh`, then scrolls and follows new output until the user scrolls up; following resumes when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`). Justification rows in sorted Activity start expanded; Thinking rows retain their streaming-driven default.
- Reasoning streaming presentation derives from the live stream phase (`streaming`/`cooldown`), never from missing persisted timing: a cached part without `time.end` is not live, and a part whose `time.end` is set never streams (issue #2020).

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
3. Validate both modes (`sorted` and `live`).

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
- User-attached context (inline code comments, terminal selections, browser
  annotations, PR comments/checks): `UserContextPart.tsx`. `UserTextPart`
  routes to it when the part's metadata carries an `openchamberContext`
  payload (see `lib/messages/contextParts.ts`, which owns both the send-time
  builder and the read-back parser). Linked GitHub issues/PRs and Linear
  issues are instead converted to link file-parts in
  `normalizeUserDisplayParts.ts`. Legacy pre-metadata messages still render
  via text sniffing (`<terminal_context>` blocks, `GitHub issue context (JSON)`
  and `Linear issue context (JSON)` prefixes).
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
