import { describe, expect, test } from 'bun:test';
import { updateShortcutRecordingState } from './ShortcutRecordingDialog';

const emptyState = { chords: [], livePreview: null };

function keyEvent(key: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey', boolean>> = {}) {
  return { key, repeat: false, isComposing: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers };
}

describe('ShortcutRecordingDialog recording state', () => {
  test('previews modifiers and clears the preview when they are released', () => {
    const pressed = updateShortcutRecordingState(emptyState, keyEvent('Control', { ctrlKey: true, shiftKey: true }), 'keydown');
    expect(pressed.state.livePreview).toBe('mod+shift');
    expect(updateShortcutRecordingState(pressed.state, keyEvent('Control'), 'keyup').state.livePreview).toBeNull();
  });

  test('records up to two chords', () => {
    const first = updateShortcutRecordingState(emptyState, keyEvent('k', { ctrlKey: true }), 'keydown');
    const second = updateShortcutRecordingState(first.state, keyEvent('p', { ctrlKey: true }), 'keydown');
    const third = updateShortcutRecordingState(second.state, keyEvent('x', { ctrlKey: true }), 'keydown');
    expect(first.state.chords).toEqual(['mod+k']);
    expect(second.state.chords).toEqual(['mod+k', 'mod+p']);
    expect(third.state.chords).toEqual(['mod+k', 'mod+p']);
  });

  test('ignores repeat and IME events', () => {
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), repeat: true }, 'keydown').state).toEqual(emptyState);
    expect(updateShortcutRecordingState(emptyState, { ...keyEvent('k', { ctrlKey: true }), isComposing: true }, 'keydown').state).toEqual(emptyState);
  });

  test('uses Enter and Escape for dialog actions and Backspace to remove the final chord', () => {
    const state = { chords: ['mod+k', 'mod+p'], livePreview: null };
    expect(updateShortcutRecordingState(state, keyEvent('Enter'), 'keydown').action).toBe('save');
    expect(updateShortcutRecordingState(state, keyEvent('Escape'), 'keydown').action).toBe('cancel');
    expect(updateShortcutRecordingState(state, keyEvent('Backspace'), 'keydown').state.chords).toEqual(['mod+k']);
  });
});
