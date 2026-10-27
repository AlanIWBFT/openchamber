import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { createContext, runInContext, Script } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import type { Rollup, ViteDevServer } from 'vite';
import request from 'supertest';
import { createWebIconScript } from './scripts/web-icons.mjs';
import { webIconsPlugin } from './vite-web-icons';

const root = fileURLToPath(new URL('./', import.meta.url));
const publicDirectory = fileURLToPath(new URL('./public/', import.meta.url));
const source = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const iconScript = createWebIconScript(publicDirectory);
const bootstrap = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!bootstrap) throw new Error('Missing manifest bootstrap script');

const metadata = {
  name: 'Server Name',
  short_name: 'Server',
  id: '/',
  start_url: '/',
  scope: '/',
  orientation: 'landscape-primary',
  icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
  shortcuts: [{
    name: 'Appearance Settings',
    url: '/?settings=appearance',
    icons: [{ src: '/pwa-192.png', sizes: '192x192', type: 'image/png' }],
  }],
};
const jsonResponse = (name = metadata.name) => new Response(JSON.stringify({ ...metadata, name }), {
  headers: { 'Content-Type': 'application/manifest+json' },
});

const openPage = (fetch: typeof globalThis.fetch, search = '', userAgent = '') => {
  const blobs = new Map<string, Blob>();
  const created: string[] = [];
  const revoked: string[] = [];
  class PageURL extends URL {
    static createObjectURL(blob: Blob) {
      const url = `blob:https://app.test:57123/${created.length}`;
      created.push(url);
      blobs.set(url, blob);
      return url;
    }
    static revokeObjectURL(url: string) {
      revoked.push(url);
      blobs.delete(url);
    }
  }
  const icons = [...source.matchAll(/<link\b[^>]*data-web-icon="([^"]+)"/g)].map(([, path]) => ({
    href: '',
    getAttribute: (name: string) => name === 'data-web-icon' ? path : null,
  }));
  const manifest = { href: '', rel: '', crossOrigin: '' };
  const touchIcons = [...source.matchAll(/<link\b[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/g)].map(([, path]) => ({
    href: path,
    getAttribute: (name: string) => name === 'href' ? path : null,
  }));
  const storage = new Map<string, string>();
  const context = createContext({
    window: {},
    navigator: { userAgent },
    location: { origin: 'https://app.test:57123', search },
    URL: PageURL,
    URLSearchParams,
    Blob,
    AbortController,
    setTimeout,
    clearTimeout,
    fetch,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    document: {
      querySelectorAll: (selector: string) => selector === 'link[rel="apple-touch-icon"]' ? touchIcons : icons,
      querySelector: () => ({ setAttribute: () => {} }),
      documentElement: { setAttribute: () => {} },
      createElement: () => manifest,
      head: { appendChild: () => {} },
    },
  });
  runInContext(iconScript + bootstrap, context);
  return {
    context, icons, touchIcons, manifest, blobs, created, revoked, storage,
    async readManifest() {
      const blob = blobs.get(manifest.href);
      if (!blob) throw new Error('Manifest has no active Blob');
      return JSON.parse(await blob.text());
    },
  };
};

describe('cacheable browser icon script', () => {
  let server: ViteDevServer;
  let html: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: false,
      root,
      plugins: [webIconsPlugin()],
      server: { middlewareMode: true, watch: null, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    html = await server.transformIndexHtml('/index.html', source);
  });

  afterAll(async () => {
    await server?.close();
  });

  it('keeps image bytes out of HTML and loads them synchronously before icon setup', async () => {
    const response = await request(server.middlewares).get('/__web-icons.js');
    expect(response.status).toBe(200);
    expect(response.text).toBe(iconScript);
    expect(response.headers['content-type']).toContain('text/javascript');
    expect(html).not.toContain('data:image/');
    const scriptTag = '<script src="/__web-icons.js"></script>';
    expect(html).toContain(scriptTag);
    expect(html.indexOf(scriptTag)).toBeLessThan(html.indexOf('data-web-icon="/pwa-192.png"'));
    expect(createWebIconScript(publicDirectory)).toBe(iconScript);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      expect(() => new Script(script)).not.toThrow();
    }
  });

  it('preserves artwork and Safari file URLs', () => {
    const context = createContext({});
    runInContext(iconScript, context);
    const svg = runInContext('openChamberWebIcons.get("/favicon.svg")', context);
    expect(Buffer.from(svg.split(',')[1], 'base64')).toEqual(readFileSync(new URL('./public/favicon.svg', import.meta.url)));
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon-180x180.png"');
    expect(html).toContain('<link rel="mask-icon" href="/favicon.svg"');
  });

  it('uses Rollup asset emission and its resolved content-hash URL in packaged HTML', () => {
    const plugin = webIconsPlugin();
    const { configResolved, buildStart, generateBundle } = plugin;
    const assets: Rollup.EmittedFile[] = [];
    configResolved({ base: '/app/', command: 'build' });
    buildStart.call({
      emitFile(asset: Rollup.EmittedFile) {
        assets.push(asset);
        return 'icon-script-reference';
      },
    });
    const asset = (fileName: string, source: string): Rollup.OutputAsset => ({
      type: 'asset', fileName, source, name: fileName, names: [fileName],
      originalFileName: null, originalFileNames: [], needsCodeReference: false,
    });
    const index = asset('index.html', source);
    const mobile = asset('mobile.html', '<html>Mobile shell</html>');
    generateBundle.call({
      getFileName(reference: string) {
        expect(reference).toBe('icon-script-reference');
        return 'assets/web-icons-ContentHash.js';
      },
    }, {}, { 'index.html': index, 'mobile.html': mobile });
    expect(assets).toEqual([{ type: 'asset', name: 'web-icons.js', source: iconScript }]);
    expect(index.source).toContain('<script src="/app/assets/web-icons-ContentHash.js"></script>');
    expect(index.source).not.toContain('data:image/');
    expect(index.source).not.toContain('<script data-web-icons>');
    expect(mobile.source).toBe('<html>Mobile shell</html>');
  });
});

describe('local manifest assembly', () => {
  it.each([
    ['Firefox Android', 'Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0', true],
    ['Firefox Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', false],
    ['Safari iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', false],
    ['Chrome Android', 'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/144.0.0.0 Mobile Safari/537.36', false],
  ])('keeps preferred Apple icons local only on %s', async (_browser, userAgent, embedded) => {
    const page = openPage(async () => jsonResponse(), '', userAgent);
    expect(page.touchIcons).toHaveLength(3);
    for (const icon of page.touchIcons) {
      const filename = icon.getAttribute('href');
      if (!filename) throw new Error('Missing touch icon path');
      const expected = embedded
        ? `data:image/png;base64,${readFileSync(new URL(`./public${filename}`, import.meta.url)).toString('base64')}`
        : filename;
      expect(icon.href).toBe(expected);
    }
    await vi.waitFor(() => expect(page.blobs.size).toBe(1));
  });

  it('fetches only small metadata once and publishes locally embedded icons with absolute launch URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());
    const page = openPage(fetch);
    expect(page.icons).toHaveLength(4);
    expect(page.icons.every((icon) => icon.href.startsWith('data:image/'))).toBe(true);
    await vi.waitFor(() => expect(page.blobs.size).toBe(1));
    const manifest = await page.readManifest();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://app.test:57123/manifest.webmanifest?orientation=system', expect.objectContaining({
      credentials: 'include', cache: 'no-store',
    }));
    expect(manifest.name).toBe('Server Name');
    expect(manifest.orientation).toBe('landscape-primary');
    for (const field of ['id', 'start_url', 'scope']) expect(manifest[field]).toBe('https://app.test:57123/');
    expect(manifest.shortcuts[0].url).toBe('https://app.test:57123/?settings=appearance');
    expect(manifest.icons[0].src).toBe(page.icons[0].href);
    expect(manifest.shortcuts[0].icons[0].src).toBe(page.icons[0].href);
    expect(page.manifest.href).toMatch(/^blob:/);
    expect(Buffer.byteLength(JSON.stringify(metadata))).toBeLessThan(3000);
  });

  it('refreshes metadata without redownloading icons and releases replaced Blob URLs', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse());
    const page = openPage(fetch);
    await vi.waitFor(() => expect(page.blobs.size).toBe(1));
    const initial = await page.readManifest();
    fetch.mockResolvedValueOnce(jsonResponse('New Name'));
    runInContext('window.__OPENCHAMBER_SET_PWA_INSTALL_NAME__("New Name")', page.context);
    await vi.waitFor(() => expect(page.created).toHaveLength(2));
    const updated = await page.readManifest();
    expect(updated.name).toBe('New Name');
    expect(updated.icons).toEqual(initial.icons);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.every(([url]) => String(url).includes('/manifest.webmanifest?'))).toBe(true);
    expect(page.revoked).toEqual([page.created[0]]);
    expect(page.blobs.size).toBe(1);
  });

  it.each([
    ['HTTP failure', () => new Response('', { status: 401 })],
    ['HTML login page', () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['malformed JSON', () => new Response('{', { headers: { 'Content-Type': 'application/json' } })],
    ['network failure', () => Promise.reject(new Error('TLS connection failed'))],
  ])('retains local name, orientation and embedded icons after %s', async (_label, response) => {
    const page = openPage(async () => response(), '?pwa_name=Local%20Name');
    await vi.waitFor(() => expect(page.blobs.size).toBe(1));
    const manifest = await page.readManifest();
    expect(manifest.name).toBe('Local Name');
    expect(manifest.icons).toHaveLength(8);
    expect(manifest.icons.every((icon: { src: string }) => icon.src.startsWith('data:image/png;base64,'))).toBe(true);
    expect(manifest.shortcuts[0].icons[0].src).toBe(page.icons[0].href);
    expect(manifest.start_url).toBe('https://app.test:57123/');
  });

  it('does not publish stale metadata after a newer update', async () => {
    let resolveFirst = (_response: Response) => {};
    const pending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse('Latest')).mockImplementationOnce(() => pending);
    const page = openPage(fetch);
    runInContext('window.__OPENCHAMBER_SET_PWA_INSTALL_NAME__("Latest")', page.context);
    await vi.waitFor(() => expect(page.created).toHaveLength(1));
    resolveFirst(jsonResponse('Stale'));
    await setImmediate();
    expect((await page.readManifest()).name).toBe('Latest');
    expect(page.created).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
