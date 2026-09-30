import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { UI_FONT_OPTION_MAP } from '@/lib/fontOptions';
import { useAppFontEffects } from './useAppFontEffects';

test('changing either font setting updates both code CSS variables without remounting', async () => {
  const dom = new Window();
  Object.defineProperty(dom, 'devicePixelRatio', { configurable: true, value: 1.5 });
  const matchMedia = dom.matchMedia.bind(dom);
  const queries: ReturnType<typeof dom.matchMedia>[] = [];
  dom.matchMedia = (query) => {
    const result = matchMedia(query);
    queries.push(result);
    return result;
  };
  const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const { monoFont, uiFont, fontPixelAlignment } = useUIStore.getState();
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    useAppFontEffects();
    return <code>中文 English</code>;
  }
  try {
    useUIStore.setState({ monoFont: 'jetbrains-mono', uiFont: 'system', fontPixelAlignment: true });
    await act(async () => root.render(<Harness />));
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--code-grid-pixel')).toBe(`${1 / 1.5}px`);
    expect(style.getPropertyValue('--font-pixel-ratio')).toBe('1.5');
    expect(style.getPropertyValue('--font-pixel-align')).toBe('1');
    await act(async () => { useUIStore.getState().setFontPixelAlignment(false); });
    expect(style.getPropertyValue('--font-pixel-align')).toBe('0');
    expect(style.getPropertyValue('--code-grid-pixel')).toBe(`${1 / 1.5}px`);
    await act(async () => { useUIStore.getState().setFontPixelAlignment(true); });
    expect(style.getPropertyValue('--font-pixel-align')).toBe('1');
    expect(style.getPropertyValue('--font-mono').startsWith('"JetBrains Mono",')).toBe(true);
    await act(async () => { useUIStore.setState({ monoFont: 'local:更纱等宽 SC' }); });
    expect(style.getPropertyValue('--font-mono').startsWith('"更纱等宽 SC",')).toBe(true);
    await act(async () => { useUIStore.setState({ uiFont: 'inter' }); });
    expect(style.getPropertyValue('--font-mono').endsWith(UI_FONT_OPTION_MAP.inter.stack)).toBe(true);
    expect(style.getPropertyValue('--font-family-mono')).toBe(style.getPropertyValue('--font-mono'));
    Object.defineProperty(dom, 'devicePixelRatio', { configurable: true, value: 2 });
    await act(async () => { queries.at(-1)?.dispatchEvent(new dom.Event('change')); });
    expect(style.getPropertyValue('--code-grid-pixel')).toBe('0.5px');
    expect(style.getPropertyValue('--font-pixel-ratio')).toBe('2');
    Object.defineProperty(dom, 'devicePixelRatio', { configurable: true, value: 1.24999997 });
    await act(async () => { queries.at(-1)?.dispatchEvent(new dom.Event('change')); });
    expect(style.getPropertyValue('--font-pixel-ratio')).toBe('1.25');
    expect(style.getPropertyValue('--code-grid-pixel')).toBe('0.8px');
  } finally {
    await act(async () => root.unmount());
    const pixelSize = document.documentElement.style.getPropertyValue('--code-grid-pixel');
    Object.defineProperty(dom, 'devicePixelRatio', { configurable: true, value: 1 });
    for (const query of queries) query.dispatchEvent(new dom.Event('change'));
    expect(document.documentElement.style.getPropertyValue('--code-grid-pixel')).toBe(pixelSize);
    useUIStore.setState({ monoFont, uiFont, fontPixelAlignment });
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
});
