import {
  isValidShortcutCombo,
  normalizeCombo,
  parseShortcut,
  UNASSIGNED_SHORTCUT,
  type ShortcutCombo,
} from './bindings';

export type ShortcutCategory = 'session' | 'models' | 'panels' | 'navigation' | 'application';

interface ShortcutDefinition<Id extends string = string> {
  id: Id;
  defaultBinding: ShortcutCombo;
  category: ShortcutCategory;
}

interface CustomizableShortcutDefinition<Id extends string = string> extends ShortcutDefinition<Id> {
  customizable: true;
  settingsLabelKey: `settings.openchamber.keyboardShortcuts.action.${Id}.label`;
}

interface InternalShortcutDefinition<Id extends string = string> extends ShortcutDefinition<Id> {
  customizable: false;
}

function internalShortcut<const Id extends string>(
  id: Id,
  defaultBinding: ShortcutCombo,
  category: ShortcutCategory,
): InternalShortcutDefinition<Id> {
  return { id, defaultBinding, category, customizable: false };
}

function customizableShortcut<const Id extends string>(
  id: Id,
  defaultBinding: ShortcutCombo,
  category: ShortcutCategory,
): CustomizableShortcutDefinition<Id> {
  return {
    id,
    defaultBinding,
    category,
    customizable: true,
    settingsLabelKey: `settings.openchamber.keyboardShortcuts.action.${id}.label`,
  };
}

/** The single static source of truth for every application-level shortcut. */
export const SHORTCUT_SCHEMA = [
  internalShortcut('save_file', 'mod+s', 'navigation'),
  internalShortcut('find_in_file', 'mod+f', 'navigation'),
  customizableShortcut('open_go_to_line', 'alt+g', 'navigation'),
  customizableShortcut('open_command_palette', 'mod+p', 'application'),
  customizableShortcut('focus_input', 'mod+i', 'session'),
  internalShortcut('open_status', 'mod+shift+o', 'application'),
  customizableShortcut('open_settings', 'mod+comma', 'application'),
  customizableShortcut('toggle_terminal', 'mod+j', 'panels'),
  customizableShortcut('toggle_terminal_expanded', 'mod+shift+j', 'panels'),
  customizableShortcut('add_selection_to_chat', 'mod+l', 'session'),
  customizableShortcut('toggle_sidebar', 'mod+alt+l', 'panels'),
  customizableShortcut('open_timeline_dialog', 'mod+t', 'session'),
  customizableShortcut('toggle_prompt_navigator', 'mod+alt+p', 'panels'),
  customizableShortcut('toggle_right_sidebar', 'mod+b', 'panels'),
  customizableShortcut('open_right_sidebar_git', 'mod+shift+g', 'panels'),
  customizableShortcut('open_right_sidebar_files', 'mod+shift+f', 'panels'),
  customizableShortcut('switch_context_surface', 'mod', 'panels'),
  customizableShortcut('new_chat', 'mod+n', 'session'),
  customizableShortcut('open_draft_project_picker', 'mod+s p', 'session'),
  customizableShortcut('open_draft_worktree_picker', 'mod+s g', 'session'),
  customizableShortcut('new_chat_worktree', 'mod+shift+n', 'session'),
  customizableShortcut('new_mini_chat', 'mod+alt+n', 'session'),
  customizableShortcut('open_help', 'mod+.', 'application'),
  customizableShortcut('toggle_context_plan', 'mod+shift+p', 'panels'),
  customizableShortcut('toggle_services_menu', 'mod+shift+s', 'panels'),
  customizableShortcut('cycle_services_tab', 'mod+shift+[', 'navigation'),
  customizableShortcut('cycle_theme', 'mod+/', 'application'),
  customizableShortcut('open_model_selector', 'mod+shift+m', 'models'),
  internalShortcut('cycle_thinking_variant', 'mod+shift+t', 'models'),
  customizableShortcut('cycle_agent', 'tab', 'models'),
  customizableShortcut('cycle_favorite_model_forward', 'ctrl+]', 'models'),
  customizableShortcut('cycle_favorite_model_backward', 'ctrl+[', 'models'),
  customizableShortcut('expand_input', 'mod+shift+e', 'session'),
  customizableShortcut('toggle_dictation', 'mod+alt+v', 'session'),
  internalShortcut('abort_run', 'escape', 'session'),
  internalShortcut('toggle_memory_debug', 'mod+shift+d', 'application'),
  internalShortcut('switch_tab_1', 'mod+1', 'navigation'),
  // Mobile tab shortcuts share numeric bindings with desktop-only panel commands.
  internalShortcut('switch_tab_2', 'mod+2', 'navigation'),
  internalShortcut('switch_tab_3', 'mod+3', 'navigation'),
  internalShortcut('switch_tab_4', 'mod+4', 'navigation'),
  internalShortcut('switch_tab_5', 'mod+5', 'navigation'),
  internalShortcut('switch_tab_6', 'mod+6', 'navigation'),
  internalShortcut('switch_tab_7', 'mod+7', 'navigation'),
  internalShortcut('switch_tab_8', 'mod+8', 'navigation'),
  internalShortcut('switch_tab_9', 'mod+9', 'navigation'),
] as const;

export type ShortcutAction = (typeof SHORTCUT_SCHEMA)[number];
export type ShortcutActionId = ShortcutAction['id'];
export type CustomizableShortcutAction = Extract<ShortcutAction, { customizable: true }>;

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_SCHEMA.find((action) => action.id === id);
}

export function getCustomizableShortcutActions(): ReadonlyArray<CustomizableShortcutAction> {
  return SHORTCUT_SCHEMA.filter(
    (action): action is CustomizableShortcutAction => action.customizable,
  );
}

export function getEffectiveShortcutCombo(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';

  const override = overrides?.[actionId];
  if (typeof override === 'string') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return '';
    if (isValidShortcutCombo(normalized)) return normalized;
  }

  return action.defaultBinding;
}

export function getEffectiveShortcutPrefix(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo {
  const action = getShortcutAction(actionId);
  if (!action) return '';

  const override = overrides?.[actionId];
  if (typeof override === 'string' && override.trim() !== '') {
    const normalized = normalizeCombo(override);
    if (normalized === UNASSIGNED_SHORTCUT) return UNASSIGNED_SHORTCUT;
    const chord = parseShortcut(normalized)?.chords[0];
    if (chord && (chord.modifiers.size > 0 || chord.key)) return normalized;
  }

  return action.defaultBinding;
}
