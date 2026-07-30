import { expect, test } from 'bun:test';
import { ShortcutRegistry } from './shortcutRegistry';

test('the first registration wins and a later unregister cannot remove it', () => {
  const registry = new ShortcutRegistry();
  const firstHandler = () => undefined;
  const first = registry.register('open_settings', firstHandler);
  const replacement = registry.register('open_settings', () => false);

  replacement();

  expect(registry.get('open_settings')).toBe(firstHandler);
  first();
  expect(registry.get('open_settings')).toBe(undefined);
});

test('a later registration takes over after the first unregisters', () => {
  const registry = new ShortcutRegistry();
  const firstHandler = () => undefined;
  const secondHandler = () => false;
  const first = registry.register('open_settings', firstHandler);
  registry.register('open_settings', secondHandler);

  expect(registry.get('open_settings')).toBe(firstHandler);
  first();
  expect(registry.get('open_settings')).toBe(secondHandler);
});
