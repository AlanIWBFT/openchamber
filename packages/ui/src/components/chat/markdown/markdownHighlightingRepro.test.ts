/**
 * Regression tests for https://github.com/openchamber/openchamber/issues/2769
 *
 * Sustained Shiki worker CPU came from re-tokenizing unchanged content:
 *  1. `htmlCache` keyed by renderer identity (`simple:${variant}`) so
 *     same-variant instances evicted each other every pass.
 *  2. LRU capped at 240 entries, so long sessions missed 100% on every pass.
 *  3. Worker/client had no result memoization.
 *
 * These tests assert the fixed contracts: content-addressed caching, room for
 * long sessions, and bounded LRU behavior.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

import { HighlightResultCache, stringPairSize } from './highlightResultCache';

let highlightCalls = 0;

const highlightCodeInWorkerMock = mock(async (code: string, lang: string) => {
  highlightCalls += 1;
  return `<pre data-lang="${lang}"><code>${code}</code></pre>`;
});

mock.module('./markdown-worker', () => ({
  highlightCodeInWorker: highlightCodeInWorkerMock,
  highlightLinesInWorker: mock(async () => null),
  highlightTokensInWorker: mock(async () => null),
  resetMarkdownWorkerClientCacheForTests: mock(() => undefined),
}));

const {
  renderMarkdownBlocks,
  resetMarkdownHtmlCacheForTests,
  markdownBlockCacheKey,
} = await import('./markdownCore');

const { resetMarkdownWorkerClientCacheForTests } = await import('./markdown-worker');

beforeEach(() => {
  resetMarkdownHtmlCacheForTests();
  resetMarkdownWorkerClientCacheForTests();
  highlightCalls = 0;
});

describe('HighlightResultCache', () => {
  test('returns cached values for identical keys and refreshes LRU order', () => {
    const cache = new HighlightResultCache<string>(
      { maxEntries: 2, maxBytes: 10_000 },
      stringPairSize,
    );
    cache.set('a', 'one');
    cache.set('b', 'two');
    expect(cache.get('a')).toBe('one');
    // Touch `a` so `b` is oldest; inserting `c` should evict `b`.
    cache.set('c', 'three');
    expect(cache.get('b')).toEqual(undefined);
    expect(cache.get('a')).toBe('one');
    expect(cache.get('c')).toBe('three');
  });

  test('evicts by byte budget while still caching a single oversized entry', () => {
    const cache = new HighlightResultCache<string>(
      { maxEntries: 10, maxBytes: 64 },
      stringPairSize,
    );
    cache.set('small', 'x');
    cache.set('huge', 'y'.repeat(200));
    expect(cache.get('huge')).toBe('y'.repeat(200));
    // Oversized insert cleared prior entries to make room.
    expect(cache.size).toBe(1);
  });
});

describe('markdownCore content-addressed htmlCache (#2769)', () => {
  test('two same-variant SimpleMarkdown-style keys do not re-highlight unchanged content', async () => {
    const toolOutputA = '```ts\nconst a = 1;\n```';
    const toolOutputB = '```ts\nconst b = 2;\n```';

    // First pass: cold miss for each distinct block.
    await renderMarkdownBlocks(toolOutputA, false, 'simple:tool');
    await renderMarkdownBlocks(toolOutputB, false, 'simple:tool');
    const coldCalls = highlightCalls;
    expect(coldCalls).toBeGreaterThan(0);

    // 100 more passes with the legacy shared `simple:tool` identity keys —
    // must not produce additional worker calls.
    for (let pass = 0; pass < 100; pass += 1) {
      await renderMarkdownBlocks(toolOutputA, false, 'simple:tool');
      await renderMarkdownBlocks(toolOutputB, false, 'simple:tool');
    }

    expect(highlightCalls).toBe(coldCalls);
  });

  test('long sessions (working set > former 240 cap) stay warm across re-render passes', async () => {
    const parts = Array.from({ length: 600 }, (_, i) => ({
      key: `markdown-part-part_${i}`,
      content: `\`\`\`ts\nconst value_${i} = ${i};\n\`\`\``,
    }));

    for (const part of parts) {
      await renderMarkdownBlocks(part.content, false, part.key);
    }
    const afterCold = highlightCalls;
    expect(afterCold).toBe(parts.length);

    for (let pass = 0; pass < 5; pass += 1) {
      for (const part of parts) {
        await renderMarkdownBlocks(part.content, false, part.key);
      }
    }

    // Unchanged content must not re-enter the worker.
    expect(highlightCalls).toBe(afterCold);
  });

  test('content changes invalidate only the changed block', async () => {
    const stable = '```ts\nconst stable = true;\n```';
    const changing = '```ts\nconst n = 1;\n```';

    await renderMarkdownBlocks(stable, false, 'a');
    await renderMarkdownBlocks(changing, false, 'b');
    const afterFirst = highlightCalls;

    await renderMarkdownBlocks(stable, false, 'a');
    await renderMarkdownBlocks('```ts\nconst n = 2;\n```', false, 'b');
    expect(highlightCalls).toBe(afterFirst + 1);

    await renderMarkdownBlocks(stable, false, 'a');
    expect(highlightCalls).toBe(afterFirst + 1);
  });

  test('block cache keys are content-addressed (mode + highlight + hash)', () => {
    expect(markdownBlockCacheKey('abc', 'full', true)).toBe('abc:full:1');
    expect(markdownBlockCacheKey('abc', 'live', false)).toBe('abc:live:0');
    expect(markdownBlockCacheKey('abc', 'full', true)).not.toBe(markdownBlockCacheKey('abc', 'full', false));
  });
});
