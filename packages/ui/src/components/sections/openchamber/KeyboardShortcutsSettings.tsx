import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsFieldRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useUIStore } from '@/stores/useUIStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  formatShortcutForDisplay,
  getCustomizableShortcutActions,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  getShortcutCategory,
  UNASSIGNED_SHORTCUT,
  type ShortcutAction,
  type ShortcutActionId,
  type ShortcutCategory,
  type ShortcutCombo,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';
import { ShortcutRecordingDialog } from './ShortcutRecordingDialog';

const CATEGORIES: ShortcutCategory[] = ['session', 'models', 'panels', 'navigation', 'application'];

export const KeyboardShortcutsSettings: React.FC = () => {
  const { t } = useI18n();
  const tUnsafe = (key: string) => t(key as Parameters<typeof t>[0]);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const setShortcutOverride = useUIStore((state) => state.setShortcutOverride);
  const clearShortcutOverride = useUIStore((state) => state.clearShortcutOverride);
  const resetAllShortcutOverrides = useUIStore((state) => state.resetAllShortcutOverrides);
  const [editingAction, setEditingAction] = React.useState<ShortcutAction | null>(null);

  const actions = React.useMemo(() => {
    const all = getCustomizableShortcutActions();
    return isVSCodeRuntime() ? all.filter((action) => action.id !== 'toggle_prompt_navigator') : all;
  }, []);
  const actionLabel = (action: ShortcutAction): string => {
    const key = `settings.openchamber.keyboardShortcuts.action.${action.id}.label`;
    const translated = tUnsafe(key);
    return translated === key ? action.label : translated;
  };
  const persist = (nextOverrides: Record<string, ShortcutCombo>) => {
    void updateDesktopSettings({ shortcutOverrides: nextOverrides });
  };
  const save = (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => {
    const nextOverrides = { ...shortcutOverrides, [actionId]: combo };
    if (replaceActionId) nextOverrides[replaceActionId] = UNASSIGNED_SHORTCUT;
    setShortcutOverride(actionId, combo);
    if (replaceActionId) setShortcutOverride(replaceActionId, UNASSIGNED_SHORTCUT);
    persist(nextOverrides);
  };
  const resetOne = (actionId: ShortcutActionId) => {
    const nextOverrides = { ...shortcutOverrides };
    delete nextOverrides[actionId];
    clearShortcutOverride(actionId);
    persist(nextOverrides);
  };
  const shortcutDisplay = (action: ShortcutAction): string => {
    const isSurfaceSwitch = action.id === 'switch_context_surface';
    const combo = isSurfaceSwitch
      ? getEffectiveShortcutPrefix(action.id, shortcutOverrides)
      : getEffectiveShortcutCombo(action.id, shortcutOverrides);
    const formatted = formatShortcutForDisplay(
      combo,
      t('settings.openchamber.keyboardShortcuts.unassigned'),
    );
    return isSurfaceSwitch && combo && combo !== UNASSIGNED_SHORTCUT
      ? `${formatted}${t('settings.openchamber.keyboardShortcuts.action.switch_context_surface.suffix')}`
      : formatted;
  };

  return (
    <>
      {CATEGORIES.map((category, categoryIndex) => {
        const categoryActions = actions.filter((action) => getShortcutCategory(action) === category);
        if (categoryActions.length === 0) return null;
        return (
          <SettingsSection
            key={category}
            settingsItem={categoryIndex === 0 ? 'shortcuts.keyboard-shortcuts' : undefined}
            title={t(`settings.openchamber.keyboardShortcuts.category.${category}`)}
            divider={categoryIndex !== 0}
            info={categoryIndex === 0 ? t('settings.openchamber.keyboardShortcuts.tooltip') : undefined}
            headerAction={categoryIndex === 0 ? (
              <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => {
                resetAllShortcutOverrides();
                persist({});
              }}>
                {t('settings.openchamber.keyboardShortcuts.actions.resetAll')}
              </Button>
            ) : undefined}
          >
            <div className="space-y-2">
              {categoryActions.map((action) => (
                <SettingsFieldRow key={action.id} label={actionLabel(action)}>
                  <kbd
                    className="min-w-32 rounded-md border border-border bg-muted px-2 py-1 text-center typography-meta font-mono text-foreground"
                  >
                    {shortcutDisplay(action)}
                  </kbd>
                  <Button
                    type="button"
                    variant="secondary"
                    size="xs"
                    className="!font-normal"
                    onClick={() => setEditingAction(action)}
                  >
                    {t('settings.openchamber.keyboardShortcuts.actions.edit')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="!font-normal"
                    onClick={() => resetOne(action.id)}
                  >
                    {t('settings.common.actions.reset')}
                  </Button>
                </SettingsFieldRow>
              ))}
            </div>
          </SettingsSection>
        );
      })}
      <ShortcutRecordingDialog
        action={editingAction}
        actions={actions}
        overrides={shortcutOverrides}
        actionLabel={actionLabel}
        onSave={save}
        onOpenChange={(open) => {
          if (!open) setEditingAction(null);
        }}
      />
    </>
  );
};
