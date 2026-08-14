import { describe, expect, mock, test } from 'bun:test';

let requestCount = 0;
const runtimeFetch = mock(async (_path: string, init?: RequestInit) => {
  requestCount += 1;
  const body = JSON.parse(String(init?.body)) as { sources: string[] };
  return new Response(JSON.stringify({
    results: body.sources.map((source) => ({ source, status: 'ready', path: `/repo/${source}` })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
});
const resolver = {
  api: () => '',
  authenticatedAsset: (path: string, query: Record<string, string | undefined>) => {
    const params = new URLSearchParams(Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])));
    return `${path}?${params}`;
  },
};

mock.module('@/lib/runtime-fetch', () => ({ runtimeFetch }));
mock.module('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => resolver }));

const { getPreparedMarkdownImageUrl, prepareLocalMarkdownImages } = await import('./markdownImageAssets');

describe('Markdown image asset preparation', () => {
  test('prepares many images in one message-level request', async () => {
    requestCount = 0;
    const sources = Array.from({ length: 12 }, (_, index) => `${index}.png`);

    const result = await prepareLocalMarkdownImages({
      sources,
      directory: '/repo',
      sessionId: 'ses_batch',
      messageId: 'msg_batch',
      signal: new AbortController().signal,
    });

    expect(result.size).toBe(12);
    expect(requestCount).toBe(1);
  });

  test('reuses preparation for one thousand messages after virtualized remounts', async () => {
    requestCount = 0;
    const requests = Array.from({ length: 1000 }, (_, index) => ({
      sources: [`${index}.png`],
      directory: '/repo',
      sessionId: 'ses_long',
      messageId: `msg_${index}`,
      signal: new AbortController().signal,
    }));

    for (const request of requests) await prepareLocalMarkdownImages(request);
    for (const request of requests) await prepareLocalMarkdownImages(request);

    expect(requestCount).toBe(1000);
  });

  test('reuses the existing authenticated raw-file asset URL', () => {
    const url = getPreparedMarkdownImageUrl({
      status: 'ready',
      path: '/tmp/opencode/image.png',
      outsideFileGrant: 'grant-1',
    }, '/repo');

    expect(url).toContain('/api/fs/raw?');
    expect(url).toContain('path=%2Ftmp%2Fopencode%2Fimage.png');
    expect(url).toContain('outsideFileGrant=grant-1');
  });
});
