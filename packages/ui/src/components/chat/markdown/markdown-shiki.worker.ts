/// <reference lib="webworker" />

import { bundledLanguages, createHighlighter, type BundledLanguage, type ThemedToken } from 'shiki';
import {
  HighlightResultCache,
  stringLinesSize,
  stringPairSize,
} from './highlightResultCache';
import { MARKDOWN_SHIKI_THEME, MARKDOWN_SHIKI_THEME_DEFINITION } from './markdownShikiThemeDefinition';
import type { MarkdownTokenRun, MarkdownWorkerRequest, MarkdownWorkerResponse } from './markdown-worker-protocol';

// Shiki FontStyle bitmask (from @shikijs/types). Inlined to avoid an extra import.
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const tokenSpan = (token: ThemedToken): string => {
  const styles: string[] = [];
  if (token.color) styles.push(`color:${token.color}`);
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & FONT_STYLE_ITALIC) styles.push('font-style:italic');
  if (fontStyle & FONT_STYLE_BOLD) styles.push('font-weight:bold');
  if (fontStyle & FONT_STYLE_UNDERLINE) styles.push('text-decoration:underline');
  const style = styles.length ? ` style="${styles.join(';')}"` : '';
  return `<span${style}>${escapeHtml(token.content)}</span>`;
};

// Single shared highlighter for the worker. Languages load lazily on demand.
let highlighter: ReturnType<typeof createHighlighter> | undefined;

// Serialize work so language loading / tokenization never overlaps.
let queue = Promise.resolve();

// Memoize tokenization by exact source. Without this, every remount / cache
// miss on the main thread re-runs codeToHtml for unchanged content and pins a
// core (openchamber/openchamber#2769).
const WORKER_CACHE_MAX_ENTRIES = 1500;
const WORKER_CACHE_MAX_BYTES = 16 * 1024 * 1024;

const htmlCache = new HighlightResultCache<string>(
  { maxEntries: WORKER_CACHE_MAX_ENTRIES, maxBytes: WORKER_CACHE_MAX_BYTES },
  stringPairSize,
);
const linesCache = new HighlightResultCache<string[]>(
  { maxEntries: WORKER_CACHE_MAX_ENTRIES, maxBytes: WORKER_CACHE_MAX_BYTES },
  stringLinesSize,
);
const tokensCache = new HighlightResultCache<MarkdownTokenRun[][]>(
  { maxEntries: WORKER_CACHE_MAX_ENTRIES, maxBytes: WORKER_CACHE_MAX_BYTES },
  (key, value) => stringPairSize(key, JSON.stringify(value)),
);

const ensureHighlighter = (): ReturnType<typeof createHighlighter> => {
  highlighter ??= createHighlighter({
    // Cast: the theme is a CSS-variable TextMate theme; Shiki accepts the shape.
    themes: [MARKDOWN_SHIKI_THEME_DEFINITION as unknown as Parameters<typeof createHighlighter>[0]['themes'][number]],
    langs: [],
  });
  return highlighter;
};

self.onmessage = (event: MessageEvent<MarkdownWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'init') {
    ensureHighlighter();
    return;
  }
  if (request.type === 'highlight') {
    queue = queue.then(() => highlight(request)).catch(() => {});
    return;
  }
  if (request.type === 'highlightTokens') {
    queue = queue.then(() => highlightTokens(request)).catch(() => {});
    return;
  }
  queue = queue.then(() => highlightLines(request)).catch(() => {});
};

type Instance = Awaited<ReturnType<typeof createHighlighter>>;

const resolveLanguage = async (instance: Instance, requested: string): Promise<string> => {
  let lang = requested in bundledLanguages ? requested : 'text';
  if (lang !== 'text' && !instance.getLoadedLanguages().includes(lang)) {
    try {
      await instance.loadLanguage(bundledLanguages[lang as BundledLanguage]);
    } catch {
      lang = 'text';
    }
  }
  return lang;
};

async function highlight(request: Extract<MarkdownWorkerRequest, { type: 'highlight' }>): Promise<void> {
  try {
    const cacheKey = `${request.lang}\0${request.code}`;
    const cached = htmlCache.get(cacheKey);
    if (cached !== undefined) {
      post({ type: 'highlight', id: request.id, html: cached });
      return;
    }
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang);
    const html = instance.codeToHtml(request.code, {
      lang,
      theme: MARKDOWN_SHIKI_THEME,
      tabindex: false,
    });
    htmlCache.set(cacheKey, html);
    post({ type: 'highlight', id: request.id, html });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightTokens(request: Extract<MarkdownWorkerRequest, { type: 'highlightTokens' }>): Promise<void> {
  try {
    const cacheKey = `${request.themeName}\0${request.lang}\0${request.code}`;
    const cached = tokensCache.get(cacheKey);
    if (cached !== undefined) {
      post({ type: 'highlightTokens', id: request.id, lines: cached });
      return;
    }
    const instance = await ensureHighlighter();
    if (request.theme && !instance.getLoadedThemes().includes(request.themeName)) {
      // Cast: a resolved TextMate theme object from the app theme registry.
      await instance.loadTheme(request.theme as Parameters<typeof instance.loadTheme>[0]);
    }
    const lang = await resolveLanguage(instance, request.lang);
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: request.themeName,
    });
    const lines = tokens.map((line) =>
      line.map((token) => [token.content.length, token.color ?? '', token.fontStyle ?? 0] as [number, string, number]),
    );
    tokensCache.set(cacheKey, lines);
    post({ type: 'highlightTokens', id: request.id, lines });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function highlightLines(request: Extract<MarkdownWorkerRequest, { type: 'highlightLines' }>): Promise<void> {
  try {
    const cacheKey = `${request.lang}\0${request.code}`;
    const cached = linesCache.get(cacheKey);
    if (cached !== undefined) {
      post({ type: 'highlightLines', id: request.id, lines: cached });
      return;
    }
    const instance = await ensureHighlighter();
    const lang = await resolveLanguage(instance, request.lang);
    const { tokens } = instance.codeToTokens(request.code, {
      lang: lang as BundledLanguage,
      theme: MARKDOWN_SHIKI_THEME,
    });
    const lines = tokens.map((line) => line.map(tokenSpan).join(''));
    linesCache.set(cacheKey, lines);
    post({ type: 'highlightLines', id: request.id, lines });
  } catch (error) {
    post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

function post(response: MarkdownWorkerResponse): void {
  self.postMessage(response);
}
