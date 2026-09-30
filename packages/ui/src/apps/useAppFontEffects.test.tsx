import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useUIStore } from '@/stores/useUIStore';
import { UI_FONT_OPTION_MAP } from '@/lib/fontOptions';
import { useAppFontEffects } from './useAppFontEffects';

test('changing either font setting updates both code CSS variables without remounting', async () => {
  const dom = new Window();
  const globals = { window: dom, document: dom.document, IS_REACT_ACT_ENVIRONMENT: true };
  const descriptors = Object.getOwnPropertyDescriptors(globalThis);
  const { monoFont, uiFont } = useUIStore.getState();
  Object.assign(globalThis, globals);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    useAppFontEffects();
    return <code>中文 English</code>;
  }
  try {
    useUIStore.setState({ monoFont: 'jetbrains-mono', uiFont: 'system' });
    await act(async () => root.render(<Harness />));
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-mono').startsWith('"JetBrains Mono",')).toBe(true);
    await act(async () => { useUIStore.setState({ monoFont: 'local:更纱等宽 SC' }); });
    expect(style.getPropertyValue('--font-mono').startsWith('"更纱等宽 SC",')).toBe(true);
    await act(async () => { useUIStore.setState({ uiFont: 'inter' }); });
    expect(style.getPropertyValue('--font-mono').endsWith(UI_FONT_OPTION_MAP.inter.stack)).toBe(true);
    expect(style.getPropertyValue('--font-family-mono')).toBe(style.getPropertyValue('--font-mono'));
  } finally {
    await act(async () => root.unmount());
    useUIStore.setState({ monoFont, uiFont });
    for (const key of Object.keys(globals)) {
      const descriptor = descriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
});
