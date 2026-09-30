import { expect, test } from 'bun:test';
import { splitCodeCellRuns } from './codeCellSpacing';

test('tracking preserves source text and complete graphemes', () => {
  const text = 'const 中文 = "你好，世界！"; e\u0301 👩🏽‍💻 ❤️ ♥︎ 1️⃣';
  const runs = splitCodeCellRuns(text);
  if (typeof runs === 'string') throw new Error('Expected mixed-width runs');
  expect(runs.map((run) => run.text).join('')).toBe(text);
  expect(runs.filter((run) => run.wide).map((run) => run.text)).toEqual(['中文', '你好，世界！', '👩🏽‍💻', '❤️', '1️⃣']);
  expect(runs.some((run) => !run.wide && run.text.includes('e\u0301'))).toBe(true);
});

test('ASCII needs no children and long Chinese text stays one run', () => {
  const ascii = 'const value = 123;\n'.repeat(1000);
  expect(splitCodeCellRuns(ascii)).toBe(ascii);
  const text = '中文'.repeat(10000);
  expect(splitCodeCellRuns(text)).toEqual([{ text, wide: true }]);
});

test('tabs, line breaks and text-presentation emoji remain literal narrow text', () => {
  expect(splitCodeCellRuns('中\t文\n♥︎')).toEqual([
    { text: '中', wide: true }, { text: '\t', wide: false },
    { text: '文', wide: true }, { text: '\n♥︎', wide: false },
  ]);
});
