import { expect, test } from 'bun:test';
import { getDropdownMenuNavigationKey } from './dropdown-menu-keyboard';

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
  expect(getDropdownMenuNavigationKey(keyEvent('n', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownMenuNavigationKey(keyEvent('p', { ctrlKey: true }))).toBe('ArrowUp');
  expect(getDropdownMenuNavigationKey(keyEvent('N', { ctrlKey: true }))).toBe('ArrowDown');
  expect(getDropdownMenuNavigationKey(keyEvent('n'))).toBe(null);
  expect(getDropdownMenuNavigationKey(keyEvent('n', { ctrlKey: true, shiftKey: true }))).toBe(null);
  expect(getDropdownMenuNavigationKey(keyEvent('p', { ctrlKey: true, altKey: true }))).toBe(null);
  expect(getDropdownMenuNavigationKey(keyEvent('p', { ctrlKey: true, metaKey: true }))).toBe(null);
});
