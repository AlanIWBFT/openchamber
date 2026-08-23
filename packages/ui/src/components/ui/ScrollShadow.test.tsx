import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ScrollShadow } from './ScrollShadow';

describe('ScrollShadow', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('keeps edge effects outside the forwarded scroll element', async () => {
    let scrollElement: HTMLElement | null = null;
    let scrollTop = 0;

    await act(async () => {
      root.render(
        <ScrollShadow
          ref={(element) => { scrollElement = element; }}
          viewportClassName="absolute inset-0"
          observeMutations={false}
        >
          <div>content</div>
        </ScrollShadow>,
      );
    });

    const scroller = host.querySelector<HTMLElement>('[data-scroll-shadow-scroller]');
    if (!scroller) throw new Error('ScrollShadow did not render its scroll element');
    expect(scrollElement).toBe(scroller);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => { scrollTop = value; },
      },
    });

    const viewport = scroller.parentElement;
    expect(viewport?.hasAttribute('data-scroll-shadow-viewport')).toBe(true);
    expect(viewport?.classList.contains('absolute')).toBe(true);
    expect(viewport?.classList.contains('relative')).toBe(false);
    expect(scroller.hasAttribute('data-scroll-shadow-scroller')).toBe(true);
    expect(viewport?.style.getPropertyValue('--scroll-shadow-size')).toBe('48px');

    await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    expect(viewport?.getAttribute('data-bottom-scroll')).toBe('true');

    scrollTop = 200;
    await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    expect(viewport?.getAttribute('data-top-bottom-scroll')).toBe('true');
    expect(viewport?.hasAttribute('data-bottom-scroll')).toBe(false);

    let attributeWrites = 0;
    if (!viewport) throw new Error('ScrollShadow did not render its viewport');
    const setAttribute = viewport.setAttribute.bind(viewport);
    viewport.setAttribute = (name, value) => {
      attributeWrites += 1;
      setAttribute(name, value);
    };
    await act(async () => scroller.dispatchEvent(new window.Event('scroll')));
    expect(attributeWrites).toBe(0);
  });
});
