# Registration boundary

Application commands use `useKeybind(actionId, handler)` or `useKeybinds(bindings)`. Both register with the shared `shortcutRegistry`, so components never receive a registry. The first registration for an action ID wins until it unregisters, then the next mounted registration takes over. A component-local interaction, such as editor navigation or an open menu, remains local event handling rather than a registered application command.

Do not add a component-level `window` or `document` keydown listener for an application command. Declare the action in `shortcuts.ts`, then register its handler near the state or UI it owns. This keeps definitions and dispatch centralized without lifting component state or passing callbacks through unrelated components.

# Module roles

- `shortcuts.ts` owns action IDs, default bindings, categories, normalization, display, and conflict rules.
- `shortcutRegistry.ts` owns the active handler for each action ID.
- `shortcutDispatcher.ts` resolves current bindings and turns keyboard events into registered command calls.
- `useKeybind.ts` ties registrations to React component lifetimes while keeping handlers current without re-registering after every render.
- Runtime hooks install one dispatcher listener for their window. The main application and Mini Chat have separate windows but use the same contracts.

# Binding rules

Bindings remain persisted as `Record<string, string>`. Each binding has one chord or at most two space-separated chords, such as `mod+s p`. `normalizeCombo`, `parseShortcut`, `formatShortcutForDisplay`, and `getShortcutConflict` provide the shared parsing and validation behavior. A single chord conflicts with a sequence sharing its first chord; sibling sequences are valid.

Contextual internal commands may deliberately share a sequence leader. The single-chord handler gets the first chance to handle the event; returning `false` lets the dispatcher start the sequence. The active file editor therefore owns `mod+s` for saving, while a mounted but unfocused editor yields `mod+s p` and `mod+s g` to the draft target pickers.

The settings recorder also stops at two chords. It keeps the recording local until the user explicitly saves, allows an exact conflict to replace the previous assignment, and blocks prefix conflicts because they make dispatch ambiguous.

# Dispatching

`ShortcutDispatcher` is DOM-independent. It invokes only currently registered handlers, resolves bindings when dispatching, and holds an active sequence prefix for 1500ms. The application keydown route clears that prefix on window blur and consumes Escape only when it cancels a prefix. A handler returns `false` to leave the completed binding unconsumed.

Terminal capture, Escape abort priming, and the shifted reverse-agent chord are input-boundary exceptions. They preserve their target-specific semantics and invoke the registered application handler rather than duplicating command behavior.

Local key handling remains appropriate for text editing, IME composition, menu and list navigation, dialog confirmation, terminal input, and other interactions that do not represent configurable application commands.
