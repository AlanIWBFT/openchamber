export function getDropdownMenuNavigationKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>): 'ArrowDown' | 'ArrowUp' | null {
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.key.toLowerCase() === 'n') return 'ArrowDown';
  if (event.key.toLowerCase() === 'p') return 'ArrowUp';
  return null;
}
