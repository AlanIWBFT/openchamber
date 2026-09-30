# Markdown code spacing

`codeCellSpacing.ts` splits syntax-token text into continuous runs of narrow and
wide graphemes. `MarkdownCode.tsx` renders `data-md-code-wide` spans around the
CJK/fullwidth and emoji runs inside each memoized React code line. It preserves
source text, token styling and grapheme boundaries. ASCII-only text adds no nodes.
Streaming keeps complete prefix row identities through the upstream highlighter;
only changed rows split their text again. React owns all nodes and CSS counters.

The shared CSS gives Markdown code blocks a 9.5pt base at 100% interface scale.
The final font size follows the UI's physical-pixel ceiling described in
`packages/ui/src/lib/theme/DOCUMENTATION.md`. It rounds the selected font's `1ch`
advance to a physical pixel, applying the
difference once to narrow characters and twice to wide runs. This preserves the
two-to-one advance of double-width coding fonts without scaling glyph outlines.
It does not turn proportional fallback glyphs into fixed-width glyphs.

`useAppFontEffects` owns `--code-grid-pixel` and updates it on resolution changes.
The browser recalculates `ch` when fonts or interface scale change. Inline code
and terminal rendering use their own typography. Code copy and selection continue
to use the original text, with no inserted spacing characters.
