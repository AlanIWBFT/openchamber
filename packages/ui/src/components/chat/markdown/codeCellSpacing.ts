// Apply two cells' tracking to CJK/fullwidth text and emoji. Keep whole graphemes
// and coalesce runs so a Chinese paragraph adds one span, not one per character.
const wideCharacter = /[\u1100-\u115f\u2329\u232a\u2e80-\u303e\u3040-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1b000}-\u{1b2ff}\u{20000}-\u{3fffd}]|\p{Emoji_Presentation}/u;
const emojiPresentation = /\p{Extended_Pictographic}.*\ufe0f|\u20e3/u;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function applyCodeCellSpacing(code: HTMLElement): void {
  if (!wideCharacter.test(code.textContent ?? '') && !emojiPresentation.test(code.textContent ?? '')) return;
  const document = code.ownerDocument;
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text && !node.parentElement?.closest('[data-md-code-wide]')) texts.push(node);
  }
  for (const text of texts) {
    if (!wideCharacter.test(text.data) && !emojiPresentation.test(text.data)) continue;
    const fragment = document.createDocumentFragment();
    let run = '';
    let wide = false;
    const append = () => {
      if (!run) return;
      if (wide) {
        const span = document.createElement('span');
        span.setAttribute('data-md-code-wide', '');
        span.textContent = run;
        fragment.append(span);
      } else {
        fragment.append(document.createTextNode(run));
      }
    };
    for (const { segment } of segmenter.segment(text.data)) {
      const nextWide = !segment.includes('\ufe0e') && (wideCharacter.test(segment) || emojiPresentation.test(segment));
      if (nextWide !== wide) {
        append();
        run = '';
        wide = nextWide;
      }
      run += segment;
    }
    append();
    text.replaceWith(fragment);
  }
}
