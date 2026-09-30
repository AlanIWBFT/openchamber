import { expect, test } from 'bun:test';
import { customFontStack, literalFontFamily, getCodeFontOptions, isMonoFontOption, resolveMonoFontStack, UI_FONT_OPTION_MAP } from './fontOptions';
import { canvasFontFamilies } from './ghostty/fonts';

const fallback = 'ui-monospace, "SFMono-Regular", monospace';

test('a single family is quoted and followed by the fallback', () => {
  expect(customFontStack('Maple Mono NF CN', fallback)).toBe(`"Maple Mono NF CN", ${fallback}`);
});

test('a comma list becomes one quoted family per entry, then the fallback', () => {
  expect(customFontStack('"Cascadia Mono", "Microsoft YaHei"', fallback))
    .toBe(`"Cascadia Mono", "Microsoft YaHei", ${fallback}`);
});

test('empty entries are dropped and characters that could end the value are stripped', () => {
  expect(customFontStack(' Inter , , Geo;rgia{} ', fallback))
    .toBe(`"Inter", "Georgia", ${fallback}`);
});

test('a value with no usable family returns the fallback alone', () => {
  expect(customFontStack('  , ; {} ', fallback)).toBe(fallback);
  expect(customFontStack('', fallback)).toBe(fallback);
});

test('missing code glyphs reach the selected UI font before any generic monospace', () => {
  for (const font of ['jetbrains-mono', 'system-mono', 'custom'] as const) {
    const stack = resolveMonoFontStack(font, 'inter', 'Sarasa Mono SC');
    expect(stack.endsWith(UI_FONT_OPTION_MAP.inter.stack)).toBe(true);
    expect(/(?:^|, )(?:(?:ui-)?monospace)(?:,|$)/.test(stack)).toBe(false);
    expect(stack.indexOf('Consolas')).toBeLessThan(stack.indexOf('Inter'));
    expect(resolveMonoFontStack(font, 'system').endsWith(UI_FONT_OPTION_MAP.system.stack)).toBe(true);
  }
  expect(resolveMonoFontStack('custom', 'inter', 'Sarasa Mono SC').startsWith('"Sarasa Mono SC",')).toBe(true);
  const customStack = resolveMonoFontStack('custom', 'custom', 'Sarasa Mono SC', 'Microsoft YaHei');
  expect(customStack.indexOf('Microsoft YaHei')).toBeGreaterThan(customStack.indexOf('Sarasa Mono SC'));
});

test('local fonts are deduplicated by family and saved choices survive unavailable discovery', () => {
  const options = getCodeFontOptions([
    { family: 'Sarasa Mono SC', label: '更纱等宽 SC' },
    { family: 'sarasa mono sc', label: '更纱等宽 SC' },
    { family: 'JetBrains Mono', label: 'JetBrains Mono' },
    { family: 'Consolas', label: 'Consolas' },
  ], 'Uninstalled Font');
  expect(options.filter((option) => option.family?.toLowerCase() === 'sarasa mono sc')).toHaveLength(1);
  expect(options.filter((option) => option.label === 'JetBrains Mono')).toHaveLength(1);
  expect(options.find((option) => option.family === 'Uninstalled Font')?.label).toBe('Uninstalled Font');
  expect(getCodeFontOptions([], 'Uninstalled Font').some((option) => option.family === 'Uninstalled Font')).toBe(true);
});

test('font preferences use custom fields and reject the old local format', () => {
  for (const value of [null, 42, 'constructor', 'toString', 'local:', 'local: bad', 'local:bad\nfont', 'local:' + 'a'.repeat(257)]) {
    expect(isMonoFontOption(value)).toBe(false);
  }
  expect(isMonoFontOption('jetbrains-mono')).toBe(true);
  expect(isMonoFontOption('custom')).toBe(true);
  expect(isMonoFontOption('local:更纱等宽 SC')).toBe(false);
  const stack = customFontStack(literalFontFamily('Font, "Quoted" \\ Name'), '');
  expect(stack).toBe('"Font\\2c  Quoted  Name"');
  expect(canvasFontFamilies(stack)).toBe(stack);
});

test('discovered comma names remain one family while typed lists keep separate fallbacks', () => {
  const saved = literalFontFamily('Mono, Local');
  const options = getCodeFontOptions([{ family: 'Mono, Local', label: 'Local mono' }], saved);
  expect(options.filter((option) => option.family === 'Mono, Local')).toHaveLength(1);
  expect(options.find((option) => option.family === 'Mono, Local')?.stack).toBe('"Mono\\2c  Local"');
  expect(customFontStack(`${saved}, Microsoft YaHei`, '')).toBe('"Mono\\2c  Local", "Microsoft YaHei"');
  expect(getCodeFontOptions([], 'Cascadia Mono, Microsoft YaHei').some((option) => option.family?.includes(','))).toBe(false);
});
