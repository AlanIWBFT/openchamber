import { describe, expect, test } from 'bun:test';
import { ShortcutDispatcher } from './shortcutDispatcher';
import { ShortcutRegistry } from './shortcutRegistry';

function key(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: `Key${key.toUpperCase()}`,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    ...options,
  } as KeyboardEvent;
}

describe('ShortcutDispatcher', () => {
  test('dispatches a sequence and consumes only leaders with active handlers', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    const unregister = registry.register('open_command_palette', (event) => {
      calls.push(event.key);
    });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'open_command_palette' ? 'g h' : '',
    });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    expect(dispatcher.dispatch(key('h'))).toBe(true);
    expect(calls).toEqual(['h']);

    unregister();
    expect(dispatcher.dispatch(key('g'))).toBe(false);
  });

  test('re-matches a prefix mismatch and clears on escape or blur', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    registry.register('open_help', () => { calls.push('single'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'open_command_palette' ? 'g h' : 'x',
    });

    dispatcher.dispatch(key('g'));
    expect(dispatcher.dispatch(key('x'))).toBe(true);
    expect(calls).toEqual(['single']);
    dispatcher.dispatch(key('g'));
    expect(dispatcher.dispatch(key('Escape'))).toBe(true);
    expect(dispatcher.handleEscape()).toBe(false);
    dispatcher.dispatch(key('g'));
    dispatcher.handleBlur();
    expect(dispatcher.dispatch(key('h'))).toBe(false);
  });

  test('expires prefixes and ignores repeats, composition, and modifier keys', () => {
    let now = 0;
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('sequence'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h', now: () => now });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    now = 1500;
    expect(dispatcher.dispatch(key('h'))).toBe(false);
    expect(dispatcher.dispatch(key('g', { repeat: true }))).toBe(false);
    expect(dispatcher.dispatch(key('g', { isComposing: true }))).toBe(false);
    expect(dispatcher.dispatch(key('Shift'))).toBe(false);
    expect(calls).toEqual([]);
  });

  test('does not consume a completed binding when every handler declines it', () => {
    const registry = new ShortcutRegistry();
    registry.register('open_command_palette', () => false);
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'g h' });

    expect(dispatcher.dispatch(key('g'))).toBe(true);
    expect(dispatcher.dispatch(key('h'))).toBe(false);
  });

  test('does not consume a single chord when its handler declines it', () => {
    const registry = new ShortcutRegistry();
    registry.register('open_command_palette', () => false);
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'x' });

    expect(dispatcher.dispatch(key('x'))).toBe(false);
  });

  test('starts a sequence when a single-chord handler with the same leader declines', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('save_file', () => false);
    registry.register('open_draft_project_picker', () => { calls.push('project'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'save_file' ? 'mod+s' : 'mod+s p',
    });

    expect(dispatcher.dispatch(key('s', { ctrlKey: true }))).toBe(true);
    expect(dispatcher.dispatch(key('p'))).toBe(true);
    expect(calls).toEqual(['project']);
  });

  test('does not start a sequence when a single-chord handler accepts the leader', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('save_file', () => { calls.push('save'); });
    registry.register('open_draft_project_picker', () => { calls.push('project'); });
    const dispatcher = new ShortcutDispatcher({
      registry,
      getBinding: (id) => id === 'save_file' ? 'mod+s' : 'mod+s p',
    });

    expect(dispatcher.dispatch(key('s', { ctrlKey: true }))).toBe(true);
    expect(dispatcher.dispatch(key('p'))).toBe(false);
    expect(calls).toEqual(['save']);
  });

  test('resolves bindings at dispatch time', () => {
    const registry = new ShortcutRegistry();
    let binding = 'x';
    const calls: string[] = [];
    registry.register('open_command_palette', (event) => { calls.push(event.key); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => binding });

    expect(dispatcher.dispatch(key('x'))).toBe(true);
    binding = 'y';
    expect(dispatcher.dispatch(key('x'))).toBe(false);
    expect(dispatcher.dispatch(key('y'))).toBe(true);
    expect(calls).toEqual(['x', 'y']);
  });

  test('stops after the first handler that accepts a conflicting binding', () => {
    const registry = new ShortcutRegistry();
    const calls: string[] = [];
    registry.register('open_command_palette', () => { calls.push('declined'); return false; });
    registry.register('open_help', () => { calls.push('first'); });
    registry.register('open_settings', () => { calls.push('second'); });
    const dispatcher = new ShortcutDispatcher({ registry, getBinding: () => 'x' });

    expect(dispatcher.dispatch(key('x'))).toBe(true);
    expect(calls).toEqual(['declined', 'first']);
  });
});
