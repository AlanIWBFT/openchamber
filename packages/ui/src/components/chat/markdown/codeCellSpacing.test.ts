import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { applyCodeCellSpacing } from './codeCellSpacing';
import { applyMarkdownCodeBlockWrapState, decorateMarkdown, getMarkdownCodeText } from './decorate';

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, Text: dom.Text, NodeFilter: dom.NodeFilter,
  HTMLElement: dom.HTMLElement, HTMLAnchorElement: dom.HTMLAnchorElement,
});
afterAll(() => dom.happyDOM.close());

test('tracking preserves syntax spans, source text and complete graphemes', () => {
  const code = document.createElement('code');
  code.innerHTML = '<span class="token">const 中文 = "你好，世界！";</span> e\u0301 👩🏽‍💻 ❤️ ♥︎ 1️⃣';
  const text = code.textContent;
  const token = code.firstElementChild;
  applyCodeCellSpacing(code);
  expect(code.textContent).toBe(text);
  expect(code.firstElementChild).toBe(token);
  expect(Array.from(code.querySelectorAll('[data-md-code-wide]'), (span) => span.textContent))
    .toEqual(['中文', '你好，世界！', '👩🏽‍💻', '❤️', '1️⃣']);
  const html = code.innerHTML;
  applyCodeCellSpacing(code);
  expect(code.innerHTML).toBe(html);
});

test('ASCII adds no nodes and a long Chinese run adds only one span', () => {
  const code = document.createElement('code');
  code.textContent = 'const value = 123;\n'.repeat(1000);
  const text = code.firstChild;
  applyCodeCellSpacing(code);
  expect(code.firstChild).toBe(text);
  expect(code.children).toHaveLength(0);
  code.textContent = '中文'.repeat(10000);
  applyCodeCellSpacing(code);
  expect(code.children).toHaveLength(1);
  expect(code.textContent).toHaveLength(20000);
});

const context: Parameters<typeof decorateMarkdown>[1] = {
  labels: {
    copy: 'Copy', copied: 'Copied', enableCodeWrap: 'Wrap', disableCodeWrap: 'Unwrap',
    enableTableWrap: 'Wrap table', disableTableWrap: 'Unwrap table',
    copyTable: 'Copy table', downloadTable: 'Download table', copyDiagram: 'Copy diagram',
    downloadDiagram: 'Download diagram', zoomInDiagram: 'Zoom in', zoomOutDiagram: 'Zoom out',
    resetDiagramView: 'Reset', previewLabel: 'Preview', previewTitle: 'Preview',
  },
  mermaidControls: { download: false, copy: false, showPanZoomControls: false },
  codeBlockLineWrap: false,
  tableCellWrap: false,
  renderMermaid: () => ({}),
};

test('streaming completion and wrap changes preserve wide tracking, copy text and line numbers', () => {
  const root = document.createElement('div');
  const source = '你好 MM\n中\t文 e\u0301\n';
  root.innerHTML = '<pre><code></code></pre>';
  const code = root.querySelector('code');
  if (!code) throw new Error('Missing code');
  code.textContent = source;
  decorateMarkdown(root, { ...context, deferCodeLineNumberSync: true });
  expect(getMarkdownCodeText(code)).toBe(source);
  expect(code.querySelectorAll('[data-md-code-wide]')).toHaveLength(3);
  applyMarkdownCodeBlockWrapState(root, true, context.labels);
  expect(getMarkdownCodeText(code)).toBe(source);
  expect(code.querySelectorAll('[data-md-code-wide]')).toHaveLength(3);
  expect(code.querySelectorAll('[data-md-code-line-number]')).toHaveLength(2);
  applyMarkdownCodeBlockWrapState(root, false, context.labels);
  expect(getMarkdownCodeText(code)).toBe(source);
  expect(code.querySelectorAll('[data-md-code-wide]')).toHaveLength(3);
});
