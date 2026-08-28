import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { hasOpenDropdown, isEditableEventTarget, shouldStopDropdownImeEscape } from './keyboard-shortcut-dom';

const domWindow = new Window();
Object.assign(globalThis, { document: domWindow.document, HTMLElement: domWindow.HTMLElement });

test('does not treat an unrelated visible listbox as an open dropdown', () => {
  const promptNavigator = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[role="listbox"]') ? promptNavigator : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(false);
});

test('detects an open dropdown popup', () => {
  const dropdown = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[data-slot="dropdown-menu-content"][data-open]') ? dropdown : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(true);
});

test('detects an open select popup', () => {
  const select = {} as Element;
  const root = {
    querySelector: (selector: string) => selector.includes('[data-slot="select-content"][data-open]') ? select : null,
  } as unknown as ParentNode;

  expect(hasOpenDropdown(root)).toBe(true);
});

test('stops IME Escape before an open dropdown dismiss listener', () => {
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: true, keyCode: 0 }, true)).toBe(true);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: false, keyCode: 229 }, true)).toBe(true);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: false, keyCode: 27 }, true)).toBe(false);
  expect(shouldStopDropdownImeEscape({ key: 'Escape', isComposing: true, keyCode: 0 }, false)).toBe(false);
});

test('treats inputs, textareas, selects, and contenteditable elements as editable targets', () => {
  expect(isEditableEventTarget(document.createElement('input'))).toBe(true);
  expect(isEditableEventTarget(document.createElement('textarea'))).toBe(true);
  expect(isEditableEventTarget(document.createElement('select'))).toBe(true);

  const editableDiv = document.createElement('div');
  Object.defineProperty(editableDiv, 'isContentEditable', { value: true });
  expect(isEditableEventTarget(editableDiv)).toBe(true);
});

test('does not treat a plain element or non-element target as editable', () => {
  expect(isEditableEventTarget(document.createElement('div'))).toBe(false);
  expect(isEditableEventTarget(document.createElement('button'))).toBe(false);
  expect(isEditableEventTarget(null)).toBe(false);
});
