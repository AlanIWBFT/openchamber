# Registration boundary

Application commands use `useKeybind(actionId, handler)` or `useKeybinds(bindings)`. Both register with the shared `shortcutRegistry`, so components never receive a registry. The first registration for an action ID wins until it unregisters, then the next mounted registration takes over. A component-local interaction, such as editor navigation or an open menu, remains local event handling rather than a registered application command.

Do not add a component-level `window` or `document` keydown listener for an application command. Declare the action in `config.ts`, then register its handler near the state or UI it owns. This keeps definitions and dispatch centralized without lifting component state or passing callbacks through unrelated components.

# Schema contract

`config.ts` is the declaration-only source for application commands. It organizes entries into `session`, `models`, `panels`, `navigation`, and `application` groups, then explicitly concatenates them into `SHORTCUT_SCHEMA`. Every entry declares an ID, default binding, and whether users can customize it. Customizable entries also declare their Settings translation key, so Settings must not maintain an action-ID switch or English fallback labels.

Configuration must not contain lookup functions, override resolution, event matching, registry state, or runtime handlers. Those concerns belong to the owning modules below. Keeping configuration declarative makes the complete shortcut inventory reviewable without reading execution code.

Component interaction keys that are not application commands, such as list navigation or text editing, do not belong in the schema. Contextual application commands do belong there even when they are not customizable; `save_file` and `find_in_file` are examples.

# Module roles

- `index.ts` is the only public import surface, exposed as `@/lib/shortcuts`.
- `config.ts` owns grouped declarations and the final `SHORTCUT_SCHEMA`.
- `schema.ts` derives action and category types and provides schema lookup and effective binding resolution.
- `bindings.ts` owns chord parsing, normalization, display, browser-risk checks, and conflict rules.
- `registry.ts` owns the active handler for each action ID.
- `dispatcher.ts` resolves current bindings and turns keyboard events into registered command calls.
- `useKeybind.ts` ties registrations to React component lifetimes while keeping handlers current without re-registering after every render.
- Runtime hooks install one dispatcher listener for their window. The main application and Mini Chat have separate windows but use the same contracts.

# Binding rules

Bindings remain persisted as `Record<string, string>`. Each binding has one chord or at most two space-separated chords, such as `mod+s p`. `normalizeCombo`, `parseShortcut`, `formatShortcutForDisplay`, and `getShortcutConflict` provide the shared parsing and validation behavior. A single chord conflicts with a sequence sharing its first chord; sibling sequences are valid.

Contextual internal commands may deliberately share a sequence leader. The single-chord handler gets the first chance to handle the event; returning `false` lets the dispatcher start the sequence. The active file editor therefore owns `mod+s` for saving, while a mounted but unfocused editor yields `mod+s p` and `mod+s g` to the draft target pickers.

Runtime-specific commands may also share an exact binding when their handlers are mutually exclusive. `open_diff_panel` handles `mod+2` on desktop, while `switch_tab_2` handles it on mobile; each returns `false` outside its runtime so the dispatcher can try the next registered action.

The settings recorder also stops at two chords. It keeps the recording local until the user explicitly saves, allows an exact conflict to replace the previous assignment, and blocks prefix conflicts because they make dispatch ambiguous.

# Dispatching

`ShortcutDispatcher` is DOM-independent. It invokes only currently registered handlers, resolves bindings when dispatching, and holds an active sequence prefix for 1500ms. The application keydown route clears that prefix on window blur and consumes Escape only when it cancels a prefix. A handler returns `false` to leave the completed binding unconsumed.

Terminal capture, Escape abort priming, and the shifted reverse-agent chord are input-boundary exceptions. They preserve their target-specific semantics and invoke the registered application handler rather than duplicating command behavior.

Local key handling remains appropriate for text editing, IME composition, menu and list navigation, dialog confirmation, terminal input, and other interactions that do not represent configurable application commands.

# Adding shortcuts

1. Add the command to the matching group in `config.ts`. Use a stable action ID and a normalized default binding. Keep sequences to at most two chords.
2. Mark the command `customizable: true` only when it should appear in Settings. Add its `settingsLabelKey` and provide that key in every locale in the same change.
3. Register the handler with `useKeybind` or `useKeybinds` near the state or UI that owns the behavior. Do not pass shortcut callbacks through unrelated components or move local UI state into a global store.
4. Return `false` when the mounted handler is not applicable in the current runtime or focus context. This lets another command sharing the binding or prefix continue dispatching.
5. Add or update schema, binding, registry, or dispatcher tests for the changed contract. Update Help Dialog metadata when the command should be discoverable there.

# Best practices

- Import production APIs only from `@/lib/shortcuts`; deep imports are reserved for files and tests inside this module.
- Keep `config.ts` declarative and grouped. Do not add helpers there for querying state or executing behavior.
- Every application command must appear exactly once in `SHORTCUT_SCHEMA`, including internal and debug commands. Component-only editing and navigation keys stay local and out of the schema.
- Avoid exact default-binding conflicts. When runtime-exclusive commands intentionally share one, document the reason beside both declarations and make each handler return `false` outside its runtime.
- Persist bindings as normalized strings. Never change the `Record<string, string>` override contract without an explicit migration and compatibility tests.
- Preserve the two-chord maximum in configuration, recording UI, parsing, conflict detection, display, and tests.
