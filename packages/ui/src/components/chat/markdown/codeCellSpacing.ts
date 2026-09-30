// Apply two cells' tracking to CJK/fullwidth text and emoji. Keep whole graphemes
// and coalesce runs so a Chinese paragraph adds one span, not one per character.
const wideCharacter = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1b000}-\u{1b2ff}\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const emojiPresentation = /\p{Extended_Pictographic}.*\ufe0f|\u20e3/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

type CodeCellRun = { text: string; wide: boolean };

/** Plain text needs no additional React children; only mixed-width tokens split. */
export function splitCodeCellRuns(text: string): string | CodeCellRun[] {
  if (!wideCharacter.test(text) && !emojiPresentation.test(text)) return text;
  const runs: CodeCellRun[] = [];
  let run = '';
  let wide = false;
  for (const { segment } of segmenter.segment(text)) {
    const nextWide = !segment.includes('\ufe0e') && (wideCharacter.test(segment) || emojiPresentation.test(segment));
    if (nextWide !== wide) {
      if (run) runs.push({ text: run, wide });
      run = '';
      wide = nextWide;
    }
    run += segment;
  }
  if (run) runs.push({ text: run, wide });
  return runs;
}
