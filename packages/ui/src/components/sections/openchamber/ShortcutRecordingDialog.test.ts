import { describe, expect, test } from 'bun:test';
import { updateShortcutRecordingState } from './ShortcutRecordingDialog';

const emptyState = { chords: [], livePreview: null };

function keyEvent(key: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  return { key, repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe('ShortcutRecordingDialog recording state', () => {
  test('previews modifiers and clears the preview when they are released', () => {
    const pressed = updateShortcutRecordingState(emptyState, keyEvent('Control', { ctrlKey: true, shiftKey: true }), 'keydown');
    expect(pressed.livePreview).toBe('mod+shift');
    expect(updateShortcutRecordingState(pressed, keyEvent('Control'), 'keyup').livePreview).toBeNull();
  });

  test('records up to two chords', () => {
    const first = updateShortcutRecordingState(emptyState, keyEvent('k', { ctrlKey: true }), 'keydown');
    const second = updateShortcutRecordingState(first, keyEvent('p', { ctrlKey: true }), 'keydown');
    const third = updateShortcutRecordingState(second, keyEvent('x', { ctrlKey: true }), 'keydown');
    expect(first.chords).toEqual(['mod+k']);
    expect(second.chords).toEqual(['mod+k', 'mod+p']);
    expect(third.chords).toEqual(['mod+k', 'mod+p']);
  });

  test('ignores repeat and IME events', () => {
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), repeat: true }, 'keydown')).toEqual(emptyState);
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), isComposing: true }, 'keydown')).toEqual(emptyState);
  });

  test('records Enter and Escape while Backspace removes the final chord', () => {
    const state = { chords: ['mod+k', 'mod+p'], livePreview: null };
    expect(updateShortcutRecordingState(emptyState, keyEvent('Enter'), 'keydown').chords).toEqual(['enter']);
    expect(updateShortcutRecordingState(emptyState, keyEvent('Escape'), 'keydown').chords).toEqual(['escape']);
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown').chords).toEqual(['mod+k']);
  });
});
