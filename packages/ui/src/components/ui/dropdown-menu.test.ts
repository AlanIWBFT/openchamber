import { expect, test } from 'bun:test';
import { getDropdownNavigationKey } from './dropdown-navigation';

function keyEvent(key: string, modifiers: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}) {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  } as KeyboardEvent;
}

test('maps only exact Ctrl+N and Ctrl+P to menu navigation keys', () => {
  expect(getDropdownNavigationKey(keyEvent('n', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true }))).toBe('ArrowUp');
  expect(getDropdownNavigationKey(keyEvent('N', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownNavigationKey(keyEvent('n'))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('n', { ctrlKey: true, shiftKey: true }))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true, altKey: true }))).toBe(null);
  expect(getDropdownNavigationKey(keyEvent('p', { ctrlKey: true, metaKey: true }))).toBe(null);
});
