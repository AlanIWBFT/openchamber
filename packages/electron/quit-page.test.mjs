import { describe, expect, test } from 'bun:test';

import {
  buildQuitPageHtml,
  buildSplashLogoSvg,
  closeMiniChatWindows,
  normalizeQuitLocale,
} from './quit-page.mjs';

describe('quit page lifecycle', () => {
  test('closes Mini Chat windows without closing the main window', () => {
    const closed = [];
    const main = { __ocMiniChat: false, isDestroyed: () => false, close: () => closed.push('main') };
    const mini = { __ocMiniChat: true, isDestroyed: () => false, close: () => closed.push('mini') };
    const destroyedMini = { __ocMiniChat: true, isDestroyed: () => true, close: () => closed.push('destroyed') };

    expect(closeMiniChatWindows([main, mini, destroyedMini])).toBe(1);
    expect(closed).toEqual(['mini']);
  });

  test('renders localized copy and rejects unsafe theme values', () => {
    expect(normalizeQuitLocale('zh-Hant-TW')).toBe('zh-TW');
    const html = buildQuitPageHtml({
      locale: 'zh-CN',
      colors: { backgroundLight: '</style><script>bad()</script>' },
    });

    expect(html).toContain('正在退出 OpenChamber');
    expect(html).toContain(buildSplashLogoSvg({ decorative: true }));
    expect(html).toContain('<svg width="120" height="120" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">');
    expect(html).not.toContain('aria-label="正在退出 OpenChamber"');
    expect(html).toContain('M50 2 L8.432 26 L50 50 L91.568 26 Z');
    expect(html).toContain('--bg: #f5f5f4');
    expect(html).not.toContain('<script>bad()');
  });

  test('keeps the startup logo exposed as an accessible image', () => {
    const svg = buildSplashLogoSvg({ ariaLabel: 'OpenChamber loading icon' });
    expect(svg).toContain('role="img" aria-label="OpenChamber loading icon"');
    expect(svg).not.toContain('aria-hidden="true"');
  });
});
