# Theme definitions and rendering

`definition.ts` parses authored JSON into the complete runtime `Theme`. Built-ins and custom-file responses use this same boundary. Embedded windows receive an already resolved theme. The server checks required authored roles and file limits; the UI validates all supported overrides before rendering. An invalid sibling is skipped, while an invalid response shape leaves the previous custom library intact.

Keep authored definitions separate from runtime colors. Optional values are meaningful defaults, not missing rendering data. `compactTheme` removes semantic defaults; the maintainer script checks resolved-color equality before replacing JSON files. Existing custom files are read without rewriting them.

`syntax.ts` owns syntax inheritance. Chat's static worker theme and the file/diff TextMate theme use `buildSyntaxTokenRules`; CodeMirror uses the same resolved palette. Changes to inheritance must preserve explicit overrides and pass compact round-trip tests. The worker theme contains CSS variables so switching palettes does not require tokenizing code again.

CodeMirror, Shiki/Pierre and chat/tool output use the authored
`syntax.base.background` directly, exposed as `--syntax-background` in CSS.
There is no global opacity or canvas-mixing adjustment. Built-in palettes keep
that background close to the canvas, using OpenChamber Light's quiet separation
as a reference. Their background-to-background contrast stays at or below 1.10;
this is a surface distinction budget, not a text contrast target. Custom themes
retain their exact authored background. Bodies and gutters use the same fill.

`color.ts` owns alpha composition and readable text selection. A solid status foreground is not the text for a tinted alert. `readableColors.ts` computes the palette used by both `cssGenerator.ts` and the extension host snapshot, including the corrected selection foreground. The SDK receives the computed text colors as required fields and applies them directly, without a second color algorithm. Color calculations run when the theme changes, not on each button render or session update.

For authoring and supported fields, see `docs/CUSTOM_THEMES.md`. Surface semantics belong to `.agents/skills/theme-system/references/tokens-and-examples.md`.

Elevated surfaces scope `--foreground` to `surface.elevatedForeground`, so neutral
children do not accidentally paint canvas text inside a popup. Opaque canvas
and secondary surfaces reset that context; code establishes its own syntax text.
Palette files are not retuned to conceal incorrect role usage.

The VS Code adapter maps the main canvas from chat/editor, secondary layout from
sidebar/panel, and the shared elevated role from an editor-widget, dropdown or
input pair in that order. OpenChamber currently has one elevated role for fields
and floating UI, so it cannot retain different VS Code input and popup fills at
the same time. Always keep the foreground paired with the chosen source.
Selection prefers the authored list pair, then menu and editor pairs, but skips
a candidate that becomes indistinguishable from a shared canvas, sidebar or
elevated surface when another authored pair remains visible. Keep the matching
foreground. This collision check does not impose a minimum contrast style on
intentionally subtle palettes. Pressed controls use toolbar-active, never list-selection. Input backgrounds are not hover
states, chat bubbles are not sidebars, and diagnostic colors are not search highlights.

A transparent input/widget border does not disable the app's generic borders;
use the next painted border role from the source palette. Transparent editor
diagnostic fills likewise fall back to status tints, because an editor underline
and an app alert have different background needs. Focus rings retain the authored
focus color and alpha rather than replacing its opacity with a fixed percentage.

File/catalog import normalizes generic borders to the built-in palettes' quiet
edge contrast: at least 1.15 on dark surfaces and 1.20 on light surfaces. It lifts
the authored hue into a readable tint and adjusts overlay alpha against canvas,
sidebar and elevated surfaces, so an opaque edge cannot disappear on one of them.
Inherited tool/divider/blockquote borders follow it; explicit component borders,
focus, status, diff and high-contrast palettes keep their authored values. Palettes
mixing light and dark surfaces retain the original border because one overlay
cannot provide that quiet contrast consistently. The live VS Code adapter does
not normalize borders, and existing saved theme files are not rewritten.

`vscode/import.ts` owns file conversion for Settings and the maintainer CLI.
It accepts bounded JSON/JSONC with literal VS Code colors. Missing neutral roles
derive from the imported canvas, while the adapter owns UI role precedence.
General semantic selectors override general TextMate rules unless semantic
highlighting is disabled. Language-specific selectors do not become global colors.
Missing code categories inherit code text, not the default OpenChamber syntax.
`include` and external token files fail explicitly instead of guessing missing data.

The provider persists imports through `POST /api/config/themes` before adding them
to its runtime-scoped library. A successful save invalidates older reloads. Runtime
switches reject late application, and newer theme choices/imports win over an
upload in flight. The server assigns content-based IDs and atomically publishes
new files without overwrite; identical retries reuse the file. VS Code keeps the
import action unavailable because its active theme belongs to VS Code.

`vscode/catalog.ts` parses server catalog/package responses and runs resolved
package sources through the same converter. Manifest labels remain authoritative;
standalone file import humanizes lowercase slug names. The dialog keeps at most
24 search results and 40 variants, debounces searches, aborts obsolete reads, and
discards the dialog on runtime changes. Batch saves are sequential, retain each
successful theme after a sibling failure, and leave the active selection alone.
Completion has a success toast and full-opacity checked rows;
partial failures remain explicit and successful variants stay installed.

All server-loaded custom themes, including manually added JSON files, expose
deletion in the existing picker. `customThemeIds` records that source independently
of ID spelling or tags. The provider commits a
successful DELETE before removing the item, invalidates older reloads, and resets
only a selected deleted ID to its built-in mode default. Runtime generations
prevent old mutations applying even after switching away and back.

`RuntimeAPIs.themeFiles` is an optional local native picker. The web adapter exposes
it only to trusted desktop pages; browser/hosted-mobile/Capacitor use file inputs.
VS Code returns 501 for theme management routes and exposes no import controls.

The import dialog explicitly renders its backdrop when nested inside Settings.
Base UI omits nested backdrops by default, so a click on the parent's backdrop
does not dismiss the child modal. Keep dismissal with the dialog primitive.
