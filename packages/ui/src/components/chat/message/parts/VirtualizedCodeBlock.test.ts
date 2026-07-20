import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'bun:test';
import { plugin } from 'bun';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { getDefaultTheme } from '@/lib/theme/themes';

// Adapt Vite's asset-query import; the component and highlighting hook are real.
plugin({ name: 'virtualized-code-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, ({ path }) => ({
    contents: `export default ${JSON.stringify(pathToFileURL(path.split('?')[0]).href)};`, loader: 'js',
  }));
} });
const { VirtualizedCodeBlock } = await import('./VirtualizedCodeBlock');
const theme = getDefaultTheme(false);
const unexpectedThemeChange = (): never => { throw new Error('Rendering must not change the theme'); };
const themeContext: ThemeContextValue = {
  currentTheme: theme, availableThemes: [theme], setTheme: unexpectedThemeChange, customThemesLoading: false,
  reloadCustomThemes: unexpectedThemeChange, importTheme: unexpectedThemeChange, deleteImportedTheme: unexpectedThemeChange,
  customThemeIds: [], isSystemPreference: false, setSystemPreference: unexpectedThemeChange,
  themeMode: 'light', setThemeMode: unexpectedThemeChange, lightThemeId: theme.metadata.id, darkThemeId: getDefaultTheme(true).metadata.id,
  setLightThemePreference: unexpectedThemeChange, setDarkThemePreference: unexpectedThemeChange,
};
const block = (count: number) => React.createElement(ThemeSystemContext.Provider, { value: themeContext },
  React.createElement(VirtualizedCodeBlock, {
    lines: Array.from({ length: count }, (_, index) => ({ text: `entry-${index}` })),
    language: 'text', maxHeight: '16rem', showLineNumbers: false,
  }));

describe('VirtualizedCodeBlock boundaries', () => {
  test('renders the complete direct list at the 80-line threshold', () => {
    expect(renderToStaticMarkup(block(80))).toContain('entry-79');
  });

  test('preserves total scroll height immediately above the threshold', () => {
    expect(renderToStaticMarkup(block(81))).toContain('height:1620px');
  });

  test('scrolls the maximum read directory page to its mounted final item', async () => {
    const happyWindow = new Window({ url: 'http://localhost' });
    const globals = {
      window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator,
      Node: happyWindow.Node, HTMLElement: happyWindow.HTMLElement, Element: happyWindow.Element,
      Event: happyWindow.Event, ResizeObserver: happyWindow.ResizeObserver,
      requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
      cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    // Happy DOM has no layout engine; supply a 256px viewport and 20px row measurements.
    Object.defineProperties(happyWindow.HTMLElement.prototype, {
      offsetHeight: { configurable: true, get(this: HTMLElement) { return this.hasAttribute('data-index') ? 20 : 256; } },
      offsetWidth: { configurable: true, get() { return 800; } },
      clientHeight: { configurable: true, get() { return 256; } },
      scrollHeight: { configurable: true, get() { return 40_000; } },
      getBoundingClientRect: { configurable: true, value(this: HTMLElement) {
        return new happyWindow.DOMRect(0, 0, 800, this.hasAttribute('data-index') ? 20 : 256);
      } },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => { root.render(block(2000)); });
      const scroller = container.querySelector<HTMLElement>('.oc-surface-code');
      if (!scroller) throw new Error('Expected the code viewport');
      await act(async () => {
        scroller.scrollTop = 39_744;
        scroller.dispatchEvent(new Event('scroll'));
      });
      expect(container.querySelector('[data-index="1999"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-index]').length).toBeLessThan(100);
    } finally {
      await act(async () => { root.unmount(); });
      await happyWindow.happyDOM.abort();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
  });
});
