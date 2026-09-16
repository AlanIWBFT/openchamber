# Example extensions

Six small extensions that exercise the SDK contract end to end. They are built
and checked in so they install as-is; edit `main.ts` and rebuild with the command
below when you change one.

| Folder | Capabilities it asks for | What it shows |
| --- | --- | --- |
| `hello-kit` | none | Every UI kit control, the pushes from the app (session, directory, theme), toast, clipboard, open URL, compose into the chat box. No approval dialog. |
| `tasks-demo` | `prompt`, `sessions`, `model`, `conversation` | A fake task list with a rail panel, a separate attach dialog, and a full-screen board. Attach tasks with status/comments in `data`, reopen their chips, link tasks to sessions, create sessions and worktrees, compose or send prompts. Message and session actions show conversation text; `/task DEMO-2` resolves a chip through `host.onResolve`, including when the panel is closed. `host.setBadge` reports open tasks. Draft summary calls the Small Model through `host.generate`. |
| `service-echo` | `service` | A local service process (Node HTTP server on loopback). The panel calls it through `host.serviceRequest` and shows status. Exercises the service approval and spawn/stop lifecycle. |
| `github-token` | `network` | A token integration against `https://api.github.com`. Paste a GitHub token in Settings → Integrations, then the panel lists your repositories through `host.request`. Exercises the OAuth/token store and the request proxy. |
| `tools-only` | none | A `package.json` and nothing else: no panel page, no `panel.entry`. One `tools` rule renders every `mcp.*` tool call in the chat with the JSON views. Shows a page-less extension: no rail icon, no + menu row, the Extensions card says "No panel". Install it, run any MCP tool, and the call's expanded body switches to the JSON summary/tree/raw views. |
| `config-editor` | `filesystem` | Reads `~/.config/opencode/opencode.json` (declared under `contributes.filesystem`), parses it, and shows it as a browsable tree (Explore tab: keys, types, drill into objects and arrays) next to a raw editor (Raw tab) that saves back atomically. Exercises the outside-project file scope, the missing-file and invalid-JSON states, and the approval dialog's pattern list. |

## Install

`tasks-demo` also declares a full-screen Tasks board. Open it from the Extension pages menu above the session list. It reads registered projects and worktrees, starts sessions without closing the board, shows live session states, opens selected chats, and saves board notes with `host.storage`. An idle session does not mark a task Done.

The `service-echo` HTTP echo works on supported desktop operating systems. Its optional `uname -a` action requires that Unix command on the server and reports an error when it is unavailable.

1. Run the app: `bun run dev` from the repo root, open the URL it prints.
2. Settings → Extensions → paste the absolute path of a folder below → Add:
   - `<repo>/packages/sdk/examples/hello-kit`
   - `<repo>/packages/sdk/examples/tasks-demo`
   - `<repo>/packages/sdk/examples/service-echo`
   - `<repo>/packages/sdk/examples/github-token`
   - `<repo>/packages/sdk/examples/config-editor`
   - `<repo>/packages/sdk/examples/tools-only`
3. Approve what the dialog lists. Remove uninstalls the extension; its panel will not run. Panel extensions appear on the context rail, while `tools-only` changes chat tool rendering without adding a panel.

## Rebuild after editing

`onReady` is a repeated snapshot, not a one-time mount event. Examples apply the theme on every snapshot, mount controls and register subscriptions once, and update existing handles afterward. Input values and selections belong to the extension. Keep them when switching tabs. Compare relevant connection/settings/item values before refreshing data or replacing content.

For Git URL installs, commit the built JavaScript and the lockfile; ignore `node_modules/`. To publish an extension update, bump its own `package.json` version, rebuild, commit, and push. OpenChamber does not build source or install dependencies during installation.

From the repo root:

```bash
bun run --cwd packages/sdk build
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/hello-kit/panel/main.ts packages/sdk/examples/hello-kit/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/github-token/panel/main.ts packages/sdk/examples/github-token/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/service-echo/panel/main.ts packages/sdk/examples/service-echo/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts --node packages/sdk/examples/service-echo/service/main.ts packages/sdk/examples/service-echo/service/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/config-editor/panel/main.ts packages/sdk/examples/config-editor/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/main.ts packages/sdk/examples/tasks-demo/panel/main.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/attach.ts packages/sdk/examples/tasks-demo/panel/attach.js
bun packages/sdk/scripts/bundle-guest.ts packages/sdk/examples/tasks-demo/panel/page.ts packages/sdk/examples/tasks-demo/panel/page.js
```

## Check against the current SDK

```bash
bun run --cwd packages/sdk type-check
bun run --cwd packages/sdk lint
bun run --cwd packages/sdk test
bun test packages/ui/src/lib/guests/sdk-examples.test.ts
```

SDK type-check and lint include all example TypeScript. Type-check resolves SDK imports to source. SDK tests validate the six manifests and compare all eight checked-in bundles with a fresh build. DOM regression tests live in the UI package, which already owns the DOM test dependency; they run the checked-in bundles against a simulated host without reading a real config or using provider credentials.
