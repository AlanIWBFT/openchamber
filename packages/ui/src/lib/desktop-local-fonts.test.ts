import { expect, test } from 'bun:test';
import { createDesktopLocalFontsAPI } from './desktop';

test('local font discovery follows trusted page capability, caches requests and retries failures', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let calls = 0;
  let fail = true;
  const fonts = [{ family: 'Sarasa Mono SC', label: '更纱等宽 SC' }];
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_API_BASE_URL__: 'https://remote.example.test',
      __OPENCHAMBER_DESKTOP__: { listMonospaceFonts: async () => {
        calls++;
        if (fail) throw new Error('Font service unavailable');
        return fonts;
      } },
    } });
    const api = createDesktopLocalFontsAPI();
    if (!api) throw new Error('Expected local font capability');
    await expect(api.listMonospace()).rejects.toThrow('Font service unavailable');
    fail = false;
    const first = api.listMonospace();
    expect(api.listMonospace()).toBe(first);
    expect(await first).toEqual(fonts);
    expect(await api.listMonospace()).toEqual(fonts);
    expect(calls).toBe(2);

    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { invoke: async () => [] },
    } });
    expect(createDesktopLocalFontsAPI()).toBeUndefined();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      __OPENCHAMBER_DESKTOP__: { listMonospaceFonts: async () => [{ family: 'bad\nfont', label: 'Bad' }] },
    } });
    await expect(createDesktopLocalFontsAPI()?.listMonospace()).rejects.toThrow();
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
