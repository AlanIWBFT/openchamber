import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/contexts/useThemeSystem', () => ({
  useThemeSystem: () => ({ currentTheme: {} }),
}));
mock.module('@/components/chat/markdown/markdownSyntaxVars', () => ({
  getMarkdownSyntaxVars: () => ({}),
}));
mock.module('@/components/code/useWorkerHighlightedLines', () => ({
  useWorkerHighlightedLines: () => ({ lines: null }),
}));

const { VirtualizedCodeBlock } = await import('./VirtualizedCodeBlock');

type FakeListener = (event: { type: string }) => void;

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  attributes: Map<string, string>;
  listeners: Map<string, Set<FakeListener>>;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  textContent: string;
  contains(target: FakeNode): boolean;
  scrollTo(options: { top?: number }): void;
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: Record<string, unknown>;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(namespace: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
}

const makeNode = (tag: string, ownerDocument: FakeDocument): FakeNode => {
  const attributes = new Map<string, string>();
  const listeners = new Map<string, Set<FakeListener>>();
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument,
    parentNode: null,
    childNodes: [],
    style: { setProperty() {}, getPropertyValue() { return ''; } },
    attributes,
    listeners,
    scrollTop: 0,
    scrollHeight: 40000,
    clientHeight: 256,
    scrollWidth: 320,
    clientWidth: 320,
    textContent: '',
    setAttribute(name: string, value: string) { attributes.set(name, String(value)); },
    removeAttribute(name: string) { attributes.delete(name); },
    hasAttribute(name: string) { return attributes.has(name); },
    getAttribute(name: string) { return attributes.get(name) ?? null; },
    addEventListener(type: string, listener: FakeListener) {
      const registered = listeners.get(type) ?? new Set<FakeListener>();
      registered.add(listener);
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: FakeListener) { listeners.get(type)?.delete(listener); },
    appendChild(child: FakeNode) { node.childNodes.push(child); child.parentNode = node; return child; },
    insertBefore(child: FakeNode, reference: FakeNode | null) {
      const index = reference ? node.childNodes.indexOf(reference) : -1;
      if (index < 0) node.childNodes.push(child);
      else node.childNodes.splice(index, 0, child);
      child.parentNode = node;
      return child;
    },
    removeChild(child: FakeNode) {
      node.childNodes = node.childNodes.filter((item) => item !== child);
      child.parentNode = null;
      return child;
    },
    contains(target: FakeNode) { return target === node || node.childNodes.some((child) => child.contains(target)); },
    getBoundingClientRect() {
      const height = attributes.has('data-index') ? 20 : 256;
      return { width: 320, height, top: 0, left: 0, right: 320, bottom: height, x: 0, y: 0 };
    },
    scrollTo(options: { top?: number }) {
      node.scrollTop = options.top ?? 0;
      listeners.get('scroll')?.forEach((listener) => listener({ type: 'scroll' }));
    },
    focus() {},
    blur() {},
  };
  return node;
};

const installDom = () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    navigator: globalThis.navigator,
    act: (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT,
  };
  const document = {
    nodeType: 9,
    nodeName: '#document',
    tagName: '#document',
    parentNode: null,
    childNodes: [],
    style: {},
    attributes: new Map(),
    listeners: new Map(),
    addEventListener() {},
    removeEventListener() {},
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_namespace: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: '#text', textContent: text, parentNode: null } as unknown as FakeNode;
    },
  } as unknown as FakeDocument;
  class ResizeObserver {
    constructor(private readonly callback: (entries: Array<Record<string, unknown>>) => void) {}
    observe(target: FakeNode) {
      const height = target.attributes.has('data-index') ? 20 : 256;
      setTimeout(() => {
        this.callback([{
          target,
          contentRect: { width: 320, height },
          borderBoxSize: [{ inlineSize: 320, blockSize: height }],
        }]);
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  }
  const window = {
    document,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    setTimeout,
    clearTimeout,
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle: () => ({ overflowY: 'auto', overflowX: 'auto' }),
    Element: class {},
    HTMLElement: class {},
    HTMLIFrameElement: class {},
  };
  document.defaultView = window;
  document.body = makeNode('body', document);
  document.documentElement = makeNode('html', document);
  Object.assign(globalThis, {
    document,
    window,
    navigator: window.navigator,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  return {
    document,
    restore() {
      Object.assign(globalThis, {
        document: previous.document,
        window: previous.window,
        navigator: previous.navigator,
        IS_REACT_ACT_ENVIRONMENT: previous.act,
      });
    },
  };
};

const findNode = (node: FakeNode, predicate: (candidate: FakeNode) => boolean): FakeNode | null => {
  if (predicate(node)) return node;
  for (const child of node.childNodes) {
    const match = findNode(child, predicate);
    if (match) return match;
  }
  return null;
};

const renderLines = (count: number) => renderToStaticMarkup(React.createElement(VirtualizedCodeBlock, {
  lines: Array.from({ length: count }, (_, index) => ({ text: `entry-${index}` })),
  language: 'text',
  maxHeight: '16rem',
  showLineNumbers: false,
}));

describe('VirtualizedCodeBlock boundaries', () => {
  test('renders the complete direct list at the 80-line threshold', () => {
    expect(renderLines(80)).toContain('entry-79');
  });

  test('preserves total scroll height immediately above the threshold', () => {
    expect(renderLines(81)).toContain('height:1620px');
  });

  test('scrolls the maximum read directory page to its mounted final item', async () => {
    const dom = installDom();
    const container = dom.document.createElement('div');
    const root = createRoot(container as unknown as Element);
    const originalConsoleError = console.error;
    console.error = (...args: Parameters<typeof console.error>) => {
      if (String(args[0] ?? '').includes('flushSync was called from inside a lifecycle method')) return;
      originalConsoleError(...args);
    };
    try {
      act(() => {
        root.render(React.createElement(VirtualizedCodeBlock, {
          lines: Array.from({ length: 2000 }, (_, index) => ({ text: `entry-${index}` })),
          language: 'text',
          maxHeight: '16rem',
          showLineNumbers: false,
        }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const scroller = findNode(container, (node) => node.attributes.get('class')?.includes('typography-code') === true);
      expect(scroller).not.toBeNull();

      await act(async () => {
        scroller?.scrollTo({ top: 40000 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const finalRow = findNode(container, (node) => node.attributes.get('data-index') === '1999');
      expect(finalRow).not.toBeNull();
    } finally {
      act(() => root.unmount());
      console.error = originalConsoleError;
      dom.restore();
    }
  });
});
