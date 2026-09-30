import { expect, test } from 'bun:test';
import { customFontStack, getCodeFontOptions, isMonoFontOption, resolveMonoFontStack, UI_FONT_OPTION_MAP } from './fontOptions';
import { canvasFontFamilies } from './ghostty/fonts';

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
  const stack = customFontStack('Font, "Quoted" \\ Name', '');
  expect(stack).toBe('"Font\\2c  Quoted  Name"');
  expect(canvasFontFamilies(stack)).toBe(stack);
});
