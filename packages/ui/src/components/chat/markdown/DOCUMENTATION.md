# Markdown file references

## Ownership

The shared renderer classifies and confirms local references before opening them through the active runtime's file viewer or editor. Filesystem access and authorization remain with the runtime adapters.

## Invariants

- Ordinary link hrefs are percent-decoded once. Inline code, fenced code, and path-looking link labels remain literal paths.
- Reference suffixes are parsed before ordinary href paths are decoded. Encoded filename characters do not become line references or anchors.
- Confirmation and clicks use the same input kind. Confirmation results distinguish hrefs from literal paths and retain directory/runtime scope.
- Existing file-URL handling, file classification, and final-path containment checks remain in place.
- Ordinary local hrefs bypass prose-only filename filters. External schemes and protocol-relative URLs are rejected before decoding.
- Encoded edge spaces remain part of the filename during resolution, existence checks, and file-tab navigation.

## Decisions

### Why explicit href input and not decoding every reference

The same resolver receives URLs and native path text. Explicit input kinds preserve a native filename such as `50%25off.md` while resolving the href `50%25off.md` to `50%off.md`.

### Why suffix parsing precedes ordinary href decoding

A literal `#L12` suffix denotes a line reference, while `%23L12` can belong to a filename. Decoding first loses that distinction and can select the wrong file.

### Why explicit local hrefs bypass prose filters

A link target can contain repeated spaces, angle brackets, or encoded `://` in its local path. Prose filters would reject these filenames and let the browser open a new tab. Scheme checks run on the encoded target so external URLs remain external.

### Why decoded href paths preserve whitespace

Text references are trimmed as prose, but an href's encoded edge spaces identify a different file. Href resolution opts out of trimming, and stat checks and absolute file-tab targets retain those spaces.

# Markdown rendering

## CJK emphasis

`streamdownPlugins.ts` supplies the upstream `@streamdown/cjk` plugin so emphasis
such as `前文**你好。**后文` renders without adding spaces or invisible characters.
Streaming, settled, clipboard and image rendering share that plugin. Regression
coverage includes punctuation-adjacent emphasis, incremental closing markers,
literal code, and CJK URL boundaries.

## Code spacing

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
