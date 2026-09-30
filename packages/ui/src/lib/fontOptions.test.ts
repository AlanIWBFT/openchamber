import { expect, test } from 'bun:test';
import { getCodeFontOptions, getMonoFontDefinition, isMonoFontOption, monoFontSchema, resolveMonoFontStack, UI_FONT_OPTION_MAP } from './fontOptions';
import { canvasFontFamilies } from './ghostty/fonts';

test('missing code glyphs reach the selected UI font before any generic monospace', () => {
  for (const font of ['jetbrains-mono', 'system-mono', 'local:Sarasa Mono SC'] as const) {
    const stack = resolveMonoFontStack(font, 'inter');
    expect(stack.endsWith(UI_FONT_OPTION_MAP.inter.stack)).toBe(true);
    expect(/(?:^|, )(?:(?:ui-)?monospace)(?:,|$)/.test(stack)).toBe(false);
    expect(stack.indexOf('Consolas')).toBeLessThan(stack.indexOf('Inter'));
    expect(resolveMonoFontStack(font, 'system').endsWith(UI_FONT_OPTION_MAP.system.stack)).toBe(true);
  }
  expect(resolveMonoFontStack('local:Sarasa Mono SC', 'inter').startsWith('"Sarasa Mono SC",')).toBe(true);
});

test('local fonts are deduplicated by family and saved choices survive unavailable discovery', () => {
  const options = getCodeFontOptions([
    { family: 'Sarasa Mono SC', label: '更纱等宽 SC' },
    { family: 'sarasa mono sc', label: '更纱等宽 SC' },
    { family: 'JetBrains Mono', label: 'JetBrains Mono' },
    { family: 'Consolas', label: 'Consolas' },
  ], 'local:Uninstalled Font');
  expect(options.filter((option) => option.id.toLowerCase() === 'local:sarasa mono sc')).toHaveLength(1);
  expect(options.filter((option) => option.label === 'JetBrains Mono')).toHaveLength(1);
  expect(options.find((option) => option.id === 'local:Uninstalled Font')?.label).toBe('Uninstalled Font');
  expect(getCodeFontOptions([], 'local:Uninstalled Font').some((option) => option.id === 'local:Uninstalled Font')).toBe(true);
});

test('font preferences accept local family names, reject malformed persisted values, and quote CSS names', () => {
  for (const value of [null, 42, 'constructor', 'toString', 'local:', 'local: bad', 'local:bad\nfont', 'local:' + 'a'.repeat(257)]) {
    expect(monoFontSchema.safeParse(value).success).toBe(false);
  }
  expect(isMonoFontOption('jetbrains-mono')).toBe(true);
  expect(isMonoFontOption('local:更纱等宽 SC')).toBe(true);
  const stack = getMonoFontDefinition('local:Font, "Quoted" \\ Name').stack;
  expect(stack).toBe('"Font\\2c  \\"Quoted\\" \\\\ Name"');
  expect(canvasFontFamilies(stack)).toBe(stack);
});
