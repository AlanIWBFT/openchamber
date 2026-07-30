import { describe, expect, test } from 'bun:test';
import {
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getShortcutAction,
  parseShortcut,
  SHORTCUT_SCHEMA,
  type ShortcutCategory,
} from './index';

describe('shortcut schema', () => {
  test('declares unique IDs and valid bindings for every application shortcut', () => {
    const ids = SHORTCUT_SCHEMA.map((action) => action.id);
    const hasValidMetadata = SHORTCUT_SCHEMA.every((action) => {
      const chordCount = parseShortcut(action.defaultBinding)?.chords.length;
      return Boolean(action.category)
        && chordCount !== undefined
        && chordCount >= 1
        && chordCount <= 2;
    });

    expect(new Set(ids).size).toBe(ids.length);
    expect(hasValidMetadata).toBe(true);
  });

  test('keeps the flattened schema grouped in Settings order', () => {
    const groupOrder: ShortcutCategory[] = [];
    for (const action of SHORTCUT_SCHEMA) {
      if (groupOrder.at(-1) !== action.category) {
        groupOrder.push(action.category);
      }
    }

    expect(groupOrder).toEqual([
      'session',
      'models',
      'panels',
      'navigation',
      'application',
    ]);
  });

  test('derives settings labels for every customizable shortcut', () => {
    const customizable = getCustomizableShortcutActions();
    expect(customizable.length).toBeGreaterThan(0);
    expect(customizable.every((action) => (
      action.settingsLabelKey === `settings.openchamber.keyboardShortcuts.action.${action.id}.label`
    ))).toBe(true);
  });

  test('includes draft prefix bindings and session metadata', () => {
    expect(getShortcutAction('open_draft_project_picker')?.defaultBinding).toBe('mod+s p');
    expect(getShortcutAction('open_draft_worktree_picker')?.defaultBinding).toBe('mod+s g');
    expect(getShortcutAction('focus_input')?.category).toBe('session');
  });

  test('preserves valid overrides and falls back from malformed bindings', () => {
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k' })).toBe('mod+k');
    expect(getEffectiveShortcutCombo('new_chat', { new_chat: 'mod+k x y' })).toBe('mod+n');
  });
});
