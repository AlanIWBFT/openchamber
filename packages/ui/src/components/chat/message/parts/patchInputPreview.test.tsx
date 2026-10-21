import { expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { PlainDiffFallback } from './PlainDiffFallback';
import { patchInputPreview } from './patchInputPreview';
import { TOOL_DIFF_PREVIEW_MAX_CHARS, TOOL_DIFF_PREVIEW_MAX_LINES } from './toolDiffPreview';

test('every JSON prefix yields only complete patch lines until the string closes', () => {
    const patch = '*** Begin Patch\n*** Update File: src/你好.ts\n@@\n-old\n+"new" \\ path 😀\n*** End Patch';
    const json = JSON.stringify({ patchText: patch });
    let previous = '';
    for (let end = 0; end <= json.length; end += 1) {
        const preview = patchInputPreview(json.slice(0, end));
        expect(patch.startsWith(preview)).toBe(true);
        expect(preview.startsWith(previous)).toBe(true);
        if (preview && preview !== patch) expect(preview.endsWith('\n')).toBe(true);
        previous = preview;
    }
    expect(previous).toBe(patch);
});

test('split unicode escapes and invalid arguments do not leak JSON into the patch', () => {
    const raw = '{"patchText":"+first\\n+\\u4f60\\u597d\\n';
    expect(patchInputPreview(raw)).toBe('+first\n+你好\n');
    expect(patchInputPreview(raw.slice(0, -4))).toBe('+first\n');
    expect(patchInputPreview('{"patchText":null}')).toBe('');
    expect(patchInputPreview('{"patchText":"+bad\\q\\n')).toBe('');
    expect(patchInputPreview('{"other":"patchText"}')).toBe('');
});

test('large previews stay within the existing text and line budgets', () => {
    const byLines = patchInputPreview(JSON.stringify({ patchText: '+line\n'.repeat(10_000) }));
    expect(byLines.split('\n').length).toBeLessThanOrEqual(TOOL_DIFF_PREVIEW_MAX_LINES + 1);
    expect(byLines.endsWith('…')).toBe(true);
    const byChars = patchInputPreview(JSON.stringify({ patchText: '+' + 'x'.repeat(TOOL_DIFF_PREVIEW_MAX_CHARS * 2) }));
    expect(byChars.length).toBeLessThanOrEqual(TOOL_DIFF_PREVIEW_MAX_CHARS + 2);
    expect(byChars.endsWith('…')).toBe(true);
});

test('plain preview colors additions and deletions and keeps generated markup inert', () => {
    const html = renderToStaticMarkup(<PlainDiffFallback diff={'*** Update File: a.ts\n-old\n+<script>bad()</script>\n context'} colorLines />);
    expect(html).toContain('var(--tools-edit-added-bg)');
    expect(html).toContain('var(--tools-edit-removed-bg)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    const fallback = renderToStaticMarkup(<PlainDiffFallback diff={'+unchanged fallback'} />);
    expect(fallback).not.toContain('--tools-edit-added-bg');
});
