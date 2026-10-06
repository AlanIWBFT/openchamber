import React from 'react';

import { SnippetAutocomplete, type SnippetAutocompleteHandle } from '@/components/chat/SnippetAutocomplete';
import { matchSnippetTrigger } from '@/components/chat/composer/language/triggers';
import { getDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import type { Snippet } from '@/types/snippet';

const PICKER_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown']);

type PickerKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'preventDefault' | 'stopPropagation'>;

/**
 * The composer's `#snippet` picker for a comment field. The host reports every
 * text or caret change through `sync`, gives its keydown to `handleKeyDown`
 * first, and renders `picker` inside a positioned wrapper; the picker opens
 * above it. Choosing a snippet writes `#trigger ` over the typed query, the way
 * the composer does; expansion happens when the message is sent.
 */
export function useCommentSnippetPicker({
  text,
  getCaret,
  replaceRange,
}: {
  text: string;
  getCaret: () => number;
  /** Replace `[from, to)` with `insert` and leave the caret after it. */
  replaceRange: (from: number, to: number, insert: string) => void;
}) {
  const [query, setQuery] = React.useState<string | null>(null);
  const pickerRef = React.useRef<SnippetAutocompleteHandle>(null);

  const sync = React.useCallback((value: string, caret: number) => {
    setQuery(matchSnippetTrigger(value, caret));
  }, []);

  const close = React.useCallback(() => setQuery(null), []);

  const select = React.useCallback((_snippet: Snippet, trigger: string) => {
    const caret = getCaret();
    const hashIndex = text.slice(0, caret).lastIndexOf('#');
    replaceRange(hashIndex === -1 ? caret : hashIndex, caret, `#${trigger} `);
    setQuery(null);
  }, [getCaret, replaceRange, text]);

  /** True when the picker took the key; the host must then ignore it. */
  const handleKeyDown = React.useCallback((event: PickerKeyEvent): boolean => {
    if (query === null || !pickerRef.current) return false;
    const key = getDropdownNavigationKey(event) ?? (PICKER_KEYS.has(event.key) && !event.shiftKey ? event.key : null);
    if (!key) return false;
    event.preventDefault();
    event.stopPropagation();
    pickerRef.current.handleKeyDown(key);
    return true;
  }, [query]);

  const picker = query === null ? null : (
    <SnippetAutocomplete
      ref={pickerRef}
      searchQuery={query}
      onSnippetSelect={select}
      onClose={close}
      style={{ left: 0, top: 'auto', bottom: 'calc(100% + 6px)', marginBottom: 0, maxWidth: '100%' }}
    />
  );

  return { sync, close, handleKeyDown, picker };
}
