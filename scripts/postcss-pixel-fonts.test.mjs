import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import tailwindcss from '@tailwindcss/postcss';
import pixelFonts from './postcss-pixel-fonts.mjs';

const require = createRequire(import.meta.resolve('@tailwindcss/postcss'));
const postcss = require('postcss');
const from = fileURLToPath(new URL('../packages/ui/src/index.css', import.meta.url));

test('rounds final sizes while retaining inheritance, root scaling and important declarations', async () => {
  const input = ':root {font-size:120%} body {font-size:1rem} .label {font-size:calc(var(--text-ui-label) * .85) !important} .child {font-size:inherit} .hidden {font-size:0}';
  const result = await postcss([pixelFonts()]).process(input, { from });
  const rules = new Map();
  result.root.walkRules((rule) => rule.walkDecls('font-size', (declaration) => rules.set(rule.selector, declaration)));
  assert.equal(rules.get(':root').value, '120%');
  assert.equal(rules.get('.child').value, 'inherit');
  assert.equal(rules.get('.hidden').value, '0');
  assert.match(rules.get('body').value, /^calc\(round\(up,/);
  assert.match(rules.get('.label').value, /\(calc\(var\(--text-ui-label\) \* \.85\)\) \* var\(--font-pixel-ratio/);
  assert.equal(rules.get('.label').important, true);
  const repeated = await postcss([pixelFonts()]).process(result.css, { from });
  assert.equal(repeated.css, result.css);
});

test('does not rewrite third-party font layout stylesheets', async () => {
  const input = '.katex {font-size:1.21em}';
  const result = await postcss([pixelFonts()]).process(input, { from: '/node_modules/katex/dist/katex.css' });
  assert.equal(result.css, input);
});

test('runs after Tailwind and covers generated arbitrary and semantic sizes', async () => {
  const input = '@import "tailwindcss" source(none); @source inline("text-xs text-[13px] text-[length:var(--text-meta)]");';
  const result = await postcss([tailwindcss({ optimize: false }), pixelFonts()]).process(input, { from });
  const sizes = [];
  result.root.walkDecls('font-size', (declaration) => sizes.push(declaration.value));
  assert.ok(sizes.some((size) => size.includes('(13px) * var(--font-pixel-ratio')));
  assert.ok(sizes.some((size) => size.includes('(var(--text-meta)) * var(--font-pixel-ratio')));
  assert.ok(sizes.some((size) => size.includes('(var(--text-xs)) * var(--font-pixel-ratio')));
});
