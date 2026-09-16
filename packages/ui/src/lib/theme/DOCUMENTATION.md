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
List selection precedes editor selection and keeps its paired foreground; pressed
controls use toolbar-active, never list-selection. Input backgrounds are not hover
states, chat bubbles are not sidebars, and diagnostic colors are not search highlights.
