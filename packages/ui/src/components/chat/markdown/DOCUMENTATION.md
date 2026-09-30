# Markdown code spacing

`codeCellSpacing.ts` adds `data-md-code-wide` spans around continuous runs of
CJK/fullwidth graphemes and emoji inside code blocks. It preserves the source text,
syntax-token elements and grapheme boundaries. ASCII-only text adds no nodes.
`decorate.ts` applies it during streaming and after line-number layout replaces
the code's children. Repeated decoration must not nest the spans.

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
