import { isMacOS } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';

type ShortcutModifier = 'mod' | 'shift' | 'alt' | 'option' | 'ctrl';
type ShortcutKey = string;
export type ShortcutCombo = string;
export type ShortcutCategory = 'session' | 'models' | 'panels' | 'navigation' | 'application';

export const UNASSIGNED_SHORTCUT: ShortcutCombo = '__unassigned__';

interface ShortcutActionDefinition {
  id: string;
  defaultCombo: ShortcutCombo;
  label: string;
  description?: string;
  customizable?: boolean;
  /** Metadata for shortcut browsers; omitted actions use the application category. */
  category?: ShortcutCategory;
}

interface ParsedShortcutChord {
  modifiers: Set<ShortcutModifier>;
  key: ShortcutKey;
}

export interface ParsedShortcut {
  chords: ReadonlyArray<ParsedShortcutChord>;
}

export type ShortcutConflict = 'exact' | 'prefix';

const DEFAULT_SHORTCUT_CATEGORY: ShortcutCategory = 'application';

const MODIFIER_KEY_MAP: Record<string, ShortcutModifier> = {
  'mod': 'mod',
  'shift': 'shift',
  'alt': 'alt',
  'option': 'alt',
  'ctrl': 'ctrl',
  'meta': 'mod',
  'cmd': 'mod',
  'command': 'mod',
};

const DISPLAY_LABEL_MAP: Record<ShortcutModifier, string> = {
  'mod': isMacOS() && isDesktopShell() ? '⌘' : 'Ctrl',
  'shift': '⇧',
  'alt': '⌥',
  'option': '⌥',
  'ctrl': '⌃',
};

// Physical `event.key` values (lowercased) that satisfy each modifier while a
// chord is being held. `mod` maps to the platform primary key; on web macOS it
// accepts either Meta or Ctrl, matching eventMatchesShortcut.
const MODIFIER_KEY_ALIASES: Record<ShortcutModifier, readonly string[]> = {
  'mod': isMacOS() && isDesktopShell() ? ['meta'] : isMacOS() ? ['meta', 'control'] : ['control'],
  'shift': ['shift'],
  'alt': ['alt'],
  'option': ['alt'],
  'ctrl': ['control'],
};

const KEY_LABEL_MAP: Record<string, string> = {
  'comma': ',',
  'period': '.',
  'enter': 'Enter',
  'escape': 'Esc',
  'tab': 'Tab',
  'space': 'Space',
  'backspace': '⌫',
  'delete': '⌦',
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'home': 'Home',
  'end': 'End',
  'pageup': 'Page Up',
  'pagedown': 'Page Down',
};

const MODIFIER_PRIORITY: ShortcutModifier[] = ['mod', 'ctrl', 'shift', 'alt'];
const RISKY_BROWSER_SHORTCUT_KEYS = new Set(['w', 't', 'r', 'p', 's', 'f', 'l', 'n']);

const SHIFTED_KEY_BASE_MAP: Record<string, string> = {
  '{': '[',
  '}': ']',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '|': '\\',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

function isUnassignedShortcut(combo: ShortcutCombo): boolean {
  return combo.trim().toLowerCase() === UNASSIGNED_SHORTCUT;
}

export function keyToShortcutToken(key: string): string {
  const lowered = key.toLowerCase();

  if (lowered === ',') return 'comma';
  if (lowered === '.') return 'period';
  if (lowered === ' ') return 'space';
  if (lowered === 'esc') return 'escape';
  if (lowered === '+') return 'plus';
  if (lowered === '-' || lowered === '_') return 'minus';
  if (lowered === 'arrowup') return 'arrowup';
  if (lowered === 'arrowdown') return 'arrowdown';
  if (lowered === 'arrowleft') return 'arrowleft';
  if (lowered === 'arrowright') return 'arrowright';

  return SHIFTED_KEY_BASE_MAP[lowered] ?? lowered;
}

const SHORTCUT_ACTIONS = [
  {
    id: 'save_file',
    defaultCombo: 'mod+s',
    label: 'Save file',
    description: 'Save the active file editor',
  },
  {
    id: 'find_in_file',
    defaultCombo: 'mod+f',
    label: 'Find in file',
    description: 'Search in the active file editor',
  },
  {
    id: 'open_go_to_line',
    defaultCombo: 'alt+g',
    label: 'Go to line (files editor)',
    description: 'Open go to line in the files editor',
    customizable: true,
    category: 'navigation',
  },
  {
    id: 'open_command_palette',
    defaultCombo: 'mod+p',
    label: 'Open command palette',
    description: 'Open the command palette',
    customizable: true,
    category: 'application',
  },
  {
    id: 'focus_input',
    defaultCombo: 'mod+i',
    label: 'Focus input',
    description: 'Focus the chat input field',
    customizable: true,
    category: 'session',
  },
  {
    id: 'open_status',
    defaultCombo: 'mod+shift+o',
    label: 'Open OpenCode status',
    description: 'Open the OpenCode status dialog',
  },
  {
    id: 'open_settings',
    defaultCombo: 'mod+comma',
    label: 'Open settings',
    description: 'Open the settings panel',
    customizable: true,
    category: 'application',
  },
  {
    id: 'toggle_terminal',
    defaultCombo: 'mod+j',
    label: 'Toggle terminal dock',
    description: 'Toggle the bottom terminal dock',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'toggle_terminal_expanded',
    defaultCombo: 'mod+shift+j',
    label: 'Toggle terminal expanded',
    description: 'Toggle terminal expanded or collapsed',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'toggle_files',
    defaultCombo: 'mod+shift+f',
    label: 'Toggle files',
    description: 'Toggle the files panel',
  },
  {
    id: 'add_selection_to_chat',
    defaultCombo: 'mod+l',
    label: 'Add selection to chat',
    description: 'Add the selected text to the chat input',
    customizable: true,
    category: 'session',
  },
  {
    id: 'toggle_sidebar',
    defaultCombo: 'mod+alt+l',
    label: 'Toggle sidebar',
    description: 'Toggle the session sidebar',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'open_timeline_dialog',
    defaultCombo: 'mod+t',
    label: 'Open conversation timeline',
    description: 'Search and navigate within current conversation',
    customizable: true,
    category: 'session',
  },
  {
    id: 'toggle_prompt_navigator',
    defaultCombo: 'mod+alt+p',
    label: 'Toggle prompt navigator',
    description: 'Show or hide the prompt navigator panel in chat',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'toggle_right_sidebar',
    defaultCombo: 'mod+b',
    label: 'Toggle right sidebar',
    description: 'Toggle the right sidebar',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'open_right_sidebar_git',
    defaultCombo: 'mod+shift+g',
    label: 'Open right sidebar Git tab',
    description: 'Open right sidebar and select Git',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'open_right_sidebar_files',
    defaultCombo: 'mod+shift+f',
    label: 'Open right sidebar Files tab',
    description: 'Open right sidebar and select Files',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'switch_context_surface',
    defaultCombo: 'mod',
    label: 'Switch context panel surface',
    description: 'Hold the modifier and press a number to open or close the matching rail icon',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'new_chat',
    defaultCombo: 'mod+n',
    label: 'New session',
    description: 'Start a new session',
    customizable: true,
    category: 'session',
  },
  {
    id: 'open_draft_project_picker',
    defaultCombo: 'mod+s p',
    label: 'Open draft project picker',
    description: 'Choose a project for a new draft',
    customizable: true,
    category: 'session',
  },
  {
    id: 'open_draft_worktree_picker',
    defaultCombo: 'mod+s g',
    label: 'Open draft worktree picker',
    description: 'Choose a worktree for a new draft',
    customizable: true,
    category: 'session',
  },
  {
    id: 'new_chat_worktree',
    defaultCombo: 'mod+shift+n',
    label: 'New worktree draft',
    description: 'Create a new worktree and open a draft in it',
    customizable: true,
    category: 'session',
  },
  {
    id: 'new_mini_chat',
    defaultCombo: 'mod+alt+n',
    label: 'New Mini Chat window',
    description: 'Open a new Mini Chat draft window',
    customizable: true,
    category: 'session',
  },
  {
    id: 'submit_message',
    defaultCombo: 'mod+enter',
    label: 'Submit message',
    description: 'Submit the current message',
  },
  {
    id: 'clear_input',
    defaultCombo: 'escape',
    label: 'Clear input',
    description: 'Clear the input field',
  },
  {
    id: 'open_help',
    defaultCombo: 'mod+.',
    label: 'Open keyboard shortcuts',
    description: 'Show the keyboard shortcuts help',
    customizable: true,
    category: 'application',
  },
  {
    id: 'toggle_context_plan',
    defaultCombo: 'mod+shift+p',
    label: 'Toggle plan context panel',
    description: 'Open or close plan in the context panel',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'toggle_services_menu',
    defaultCombo: 'mod+shift+s',
    label: 'Toggle services menu',
    description: 'Open or close the services menu',
    customizable: true,
    category: 'panels',
  },
  {
    id: 'cycle_services_tab',
    defaultCombo: 'mod+shift+[',
    label: 'Cycle services tab',
    description: 'Cycle through tabs in the services menu',
    customizable: true,
    category: 'navigation',
  },
  {
    id: 'cycle_theme',
    defaultCombo: 'mod+/',
    label: 'Cycle theme',
    description: 'Cycle between light, dark, and system theme',
    customizable: true,
    category: 'application',
  },
  {
    id: 'open_model_selector',
    defaultCombo: 'mod+shift+m',
    label: 'Open model selector',
    description: 'Open model selector while in chat',
    customizable: true,
    category: 'models',
  },
  {
    id: 'cycle_thinking_variant',
    defaultCombo: 'mod+shift+t',
    label: 'Cycle thinking variant',
    description: 'Cycle thinking variant while in chat',
  },
  {
    id: 'cycle_agent',
    defaultCombo: 'tab',
    label: 'Cycle agent',
    description: 'Cycle agent while the model selector is open',
    customizable: true,
    category: 'models',
  },
  {
    id: 'cycle_favorite_model_forward',
    defaultCombo: 'ctrl+]',
    label: 'Cycle favorite model forward',
    description: 'Cycle forward through starred models without opening the picker',
    customizable: true,
    category: 'models',
  },
  {
    id: 'cycle_favorite_model_backward',
    defaultCombo: 'ctrl+[',
    label: 'Cycle favorite model backward',
    description: 'Cycle backward through starred models without opening the picker',
    customizable: true,
    category: 'models',
  },
  {
    id: 'expand_input',
    defaultCombo: 'mod+shift+e',
    label: 'Expand input',
    description: 'Toggle focus mode for the chat input',
    customizable: true,
    category: 'session',
  },
  {
    id: 'toggle_dictation',
    defaultCombo: 'mod+alt+v',
    label: 'Voice input',
    description: 'Start dictation; press again to confirm and insert the transcript',
    customizable: true,
    category: 'session',
  },
  {
    id: 'abort_run',
    defaultCombo: 'escape',
    label: 'Abort active run',
    description: 'Abort the currently running task (double press)',
  },
  {
    id: 'switch_tab_1',
    defaultCombo: 'mod+1',
    label: 'Switch to tab 1',
    description: 'Switch to the first tab or project',
  },
  {
    id: 'switch_tab_2',
    defaultCombo: 'mod+2',
    label: 'Switch to tab 2',
    description: 'Switch to the second tab or project',
  },
  {
    id: 'switch_tab_3',
    defaultCombo: 'mod+3',
    label: 'Switch to tab 3',
    description: 'Switch to the third tab or project',
  },
  {
    id: 'switch_tab_4',
    defaultCombo: 'mod+4',
    label: 'Switch to tab 4',
    description: 'Switch to the fourth tab or project',
  },
  {
    id: 'switch_tab_5',
    defaultCombo: 'mod+5',
    label: 'Switch to tab 5',
    description: 'Switch to the fifth tab or project',
  },
  {
    id: 'switch_tab_6',
    defaultCombo: 'mod+6',
    label: 'Switch to tab 6',
    description: 'Switch to the sixth tab or project',
  },
  {
    id: 'switch_tab_7',
    defaultCombo: 'mod+7',
    label: 'Switch to tab 7',
    description: 'Switch to the seventh tab or project',
  },
  {
    id: 'switch_tab_8',
    defaultCombo: 'mod+8',
    label: 'Switch to tab 8',
    description: 'Switch to the eighth tab or project',
  },
  {
    id: 'switch_tab_9',
    defaultCombo: 'mod+9',
    label: 'Switch to tab 9',
    description: 'Switch to the ninth tab or project',
  },
] as const satisfies ReadonlyArray<ShortcutActionDefinition>;

export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]['id'];
export type ShortcutAction = Omit<ShortcutActionDefinition, 'id'> & { id: ShortcutActionId };

export function normalizeCombo(combo: ShortcutCombo): ShortcutCombo {
  if (isUnassignedShortcut(combo)) {
    return UNASSIGNED_SHORTCUT;
  }

  const chords = combo.trim().replace(/\s*\+\s*/g, '+').split(/\s+/).filter(Boolean);
  if (chords.length === 0 || chords.length > 2) {
    return '';
  }

  return chords.map(normalizeChord).join(' ');
}

function normalizeChord(combo: ShortcutCombo): ShortcutCombo {
  const rawParts = combo
    .toLowerCase()
    .trim()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  const modifiers = new Set<ShortcutModifier>();
  let key = '';

  for (const rawPart of rawParts) {
    const part = rawPart === ',' ? 'comma' : rawPart === '.' ? 'period' : rawPart;
    const modifier = MODIFIER_KEY_MAP[part];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    key = part;
  }

  const orderedModifiers = MODIFIER_PRIORITY.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].filter(Boolean).join('+');
}

function isValidShortcutCombo(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return true;
  }

  const parsed = parseShortcut(combo);
  return parsed !== undefined && parsed.chords.every((chord) => chord.key.trim().length > 0);
}

export function parseShortcut(combo: ShortcutCombo): ParsedShortcut | undefined {
  if (isUnassignedShortcut(combo)) {
    return { chords: [{ modifiers: new Set<ShortcutModifier>(), key: UNASSIGNED_SHORTCUT }] };
  }

  const normalized = normalizeCombo(combo);
  if (!normalized) {
    return undefined;
  }

  const chords = normalized.split(' ').map((chord) => {
    const parts = chord.split('+');
    const modifiers: Set<ShortcutModifier> = new Set();
    let key: ShortcutKey = '';

    for (const part of parts) {
      const modifier = MODIFIER_KEY_MAP[part];
      if (modifier) {
        modifiers.add(modifier);
      } else {
        key = part;
      }
    }

    return { modifiers, key };
  });

  return { chords };
}

export function formatShortcutForDisplay(combo: ShortcutCombo, unassignedLabel = 'Unassigned'): string {
  if (isUnassignedShortcut(combo)) {
    return unassignedLabel;
  }

  const parsed = parseShortcut(combo);

  if (!parsed || parsed.chords.some((chord) => !chord.key && chord.modifiers.size === 0)) {
    return unassignedLabel;
  }

  return parsed.chords.map(formatChordForDisplay).join(', ');
}

function formatChordForDisplay(parsed: ParsedShortcutChord): string {
  const parts: string[] = [];

  for (const modifier of MODIFIER_PRIORITY) {
    if (parsed.modifiers.has(modifier)) {
      parts.push(DISPLAY_LABEL_MAP[modifier]);
    }
  }

  if (parsed.key) {
    const keyLabel = KEY_LABEL_MAP[parsed.key.toLowerCase()] || parsed.key.toUpperCase();
    parts.push(keyLabel);
  }

  return parts.join(' + ');
}

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<ShortcutAction> {
  return SHORTCUT_ACTIONS.filter((action) => 'customizable' in action && action.customizable === true);
}

export function getShortcutCategory(action: ShortcutAction): ShortcutCategory {
  return action.category ?? DEFAULT_SHORTCUT_CATEGORY;
}

export function getShortcutConflict(left: ShortcutCombo, right: ShortcutCombo): ShortcutConflict | undefined {
  const normalizedLeft = normalizeCombo(left);
  const normalizedRight = normalizeCombo(right);
  const hasInvalidBinding = !isValidShortcutCombo(normalizedLeft)
    || !isValidShortcutCombo(normalizedRight);
  const hasUnassignedBinding = normalizedLeft === UNASSIGNED_SHORTCUT
    || normalizedRight === UNASSIGNED_SHORTCUT;
  if (hasInvalidBinding || hasUnassignedBinding) {
    return undefined;
  }

  if (normalizedLeft === normalizedRight) {
    return 'exact';
  }

  const leftChords = normalizedLeft.split(' ');
  const rightChords = normalizedRight.split(' ');
  const sharesLeader = leftChords[0] === rightChords[0];
  return sharesLeader && leftChords.length !== rightChords.length ? 'prefix' : undefined;
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) {
    return '';
  }

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) {
      return '';
    }

    if (isValidShortcutCombo(normalized)) {
      return normalized;
    }
  }

  return action.defaultCombo;
}

export function isRiskyBrowserShortcut(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);
  if (!parsed) {
    return false;
  }
  const chord = parsed.chords[0];
  if (!chord.modifiers.has('mod')) {
    return false;
  }

  const key = chord.key.toLowerCase();
  return RISKY_BROWSER_SHORTCUT_KEYS.has(key)
    && !chord.modifiers.has('shift')
    && !chord.modifiers.has('alt');
}

export function eventMatchesShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  shortcut: ShortcutAction | ShortcutCombo
): boolean {
  const combo = typeof shortcut === 'string' ? shortcut : shortcut.defaultCombo;
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);
  if (!parsed || parsed.chords.length !== 1) {
    return false;
  }
  const chord = parsed.chords[0];

  const expectedMod = chord.modifiers.has('mod');
  const expectedShift = chord.modifiers.has('shift');
  const expectedAlt = chord.modifiers.has('alt');
  const expectedCtrl = chord.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();

  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (expectedMod && !modMatches) {
    return false;
  }

  if (!expectedMod && event.metaKey) {
    return false;
  }

  if (expectedShift !== event.shiftKey) {
    return false;
  }

  if (expectedAlt !== event.altKey) {
    return false;
  }

  if (expectedCtrl) {
    if (!event.ctrlKey) {
      return false;
    }
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) {
      return false;
    }
  }

  let eventKeyRaw = event.key;
  if (event.altKey) {
    if (event.code.startsWith('Key') && event.code.length === 4) {
      eventKeyRaw = event.code.slice(3).toLowerCase();
    } else if (event.code.startsWith('Digit') && event.code.length === 6) {
      eventKeyRaw = event.code.slice(5);
    }
  }

  const eventKey = keyToShortcutToken(eventKeyRaw);
  const expectedKey = keyToShortcutToken(chord.key);

  return eventKey === expectedKey;
}

export function getModifierLabel(): string {
  return isMacOS() && isDesktopShell() ? '⌘' : 'Ctrl';
}

/**
 * Resolves the configurable prefix for chord-style shortcuts such as
 * "switch context panel surface", where a trailing digit key completes the
 * combo. Unlike getEffectiveShortcutCombo, modifier-only overrides (e.g. the
 * bare `mod` primary key) are honored so the prefix can omit a primary key.
 * Returns UNASSIGNED_SHORTCUT when the user explicitly unassigned the prefix.
 */
export function getEffectiveShortcutPrefix(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) {
    return '';
  }

  const override = overrides?.[actionId];
  if (typeof override === 'string' && override.trim() !== '') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) {
      return UNASSIGNED_SHORTCUT;
    }
    if (normalized) {
      const parsed = parseShortcut(normalized);
      const chord = parsed?.chords[0];
      if (chord && (chord.modifiers.size > 0 || chord.key)) {
        return normalized;
      }
    }
  }

  return action.defaultCombo;
}

/**
 * True when the physical keys required to "arm" a prefix combo are currently
 * held. For modifiers with multiple aliases (e.g. `mod` on web macOS), at
 * least one alias must be held.
 */
export function isShortcutPrefixHeld(prefixCombo: ShortcutCombo, heldKeys: ReadonlySet<string>): boolean {
  if (isUnassignedShortcut(prefixCombo)) {
    return false;
  }

  const parsed = parseShortcut(prefixCombo);
  if (!parsed || parsed.chords.length !== 1) {
    return false;
  }
  const chord = parsed.chords[0];

  for (const modifier of chord.modifiers) {
    const aliases = MODIFIER_KEY_ALIASES[modifier];
    if (!aliases.some((alias) => heldKeys.has(alias))) {
      return false;
    }
  }

  if (chord.key && !heldKeys.has(chord.key.toLowerCase())) {
    return false;
  }

  return true;
}

/**
 * Matches an activating keydown (the caller checks the event's own key, e.g. a
 * digit) against a chord prefix: the event's modifier state must match the
 * prefix's modifiers, and when the prefix has a primary key that key must
 * currently be held.
 */
export function eventMatchesShortcutPrefix(
  event: KeyboardEvent | React.KeyboardEvent,
  prefixCombo: ShortcutCombo,
  heldKeys?: ReadonlySet<string>,
): boolean {
  if (isUnassignedShortcut(prefixCombo)) {
    return false;
  }

  const parsed = parseShortcut(prefixCombo);
  if (!parsed || parsed.chords.length !== 1) {
    return false;
  }
  const chord = parsed.chords[0];

  const expectedMod = chord.modifiers.has('mod');
  const expectedShift = chord.modifiers.has('shift');
  const expectedAlt = chord.modifiers.has('alt');
  const expectedCtrl = chord.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();

  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (expectedMod && !modMatches) {
    return false;
  }

  if (!expectedMod && event.metaKey) {
    return false;
  }

  if (expectedShift !== event.shiftKey) {
    return false;
  }

  if (expectedAlt !== event.altKey) {
    return false;
  }

  if (expectedCtrl) {
    if (!event.ctrlKey) {
      return false;
    }
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) {
      return false;
    }
  }

  if (chord.key && (!heldKeys || !heldKeys.has(chord.key.toLowerCase()))) {
    return false;
  }

  return true;
}
