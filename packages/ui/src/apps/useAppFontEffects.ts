import React from 'react';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { useUIStore } from '@/stores/useUIStore';
import { CUSTOM_FONT_ID, DEFAULT_UI_FONT, UI_FONT_OPTION_MAP, customFontStack, resolveMonoFontStack } from '@/lib/fontOptions';
import { loadMonoFont, loadUiFont } from '@/lib/fontLoader';

export function useAppFontEffects() {
  const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
  const fontPixelAlignment = useUIStore(state => state.fontPixelAlignment);

  React.useLayoutEffect(() => {
    globalThis.document?.documentElement.style.setProperty('--font-pixel-align', fontPixelAlignment ? '1' : '0');
  }, [fontPixelAlignment]);

  React.useLayoutEffect(() => {
    const window = globalThis.window;
    const root = globalThis.document?.documentElement;
    if (!window || !root) return;
    let resolution: MediaQueryList | undefined;
    const updatePixelSize = () => {
      resolution?.removeEventListener('change', updatePixelSize);
      const ratio = window.devicePixelRatio || 1;
      // Chromium zoom can report values such as 1.24999997 for a 1.25 scale.
      const pixelRatio = Math.round(ratio * 1_000_000) / 1_000_000;
      root.style.setProperty('--font-pixel-ratio', String(pixelRatio));
      root.style.setProperty('--code-grid-pixel', `${1 / pixelRatio}px`);
      resolution = window.matchMedia(`(resolution: ${ratio}dppx)`);
      resolution.addEventListener('change', updatePixelSize);
    };
    updatePixelSize();
    return () => resolution?.removeEventListener('change', updatePixelSize);
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const defaultUiStack = UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack;
    const uiStack = uiFont === CUSTOM_FONT_ID
      ? customFontStack(customUiFont, defaultUiStack)
      : UI_FONT_OPTION_MAP[uiFont]?.stack ?? defaultUiStack;
    const monoStack = resolveMonoFontStack(monoFont, uiFont, customMonoFont, customUiFont);
    void loadUiFont(uiFont);
    void loadMonoFont(monoFont);

    root.style.setProperty('--font-sans', uiStack);
    root.style.setProperty('--font-heading', uiStack);
    root.style.setProperty('--font-family-sans', uiStack);
    root.style.setProperty('--font-mono', monoStack);
    root.style.setProperty('--font-family-mono', monoStack);
    root.style.setProperty('--ui-regular-font-weight', '400');

    if (document.body) {
      document.body.style.fontFamily = uiStack;
    }
  }, [uiFont, monoFont, customUiFont, customMonoFont]);
}
