import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import {
  formatShortcutForDisplay,
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  getShortcutConflict,
  isRiskyBrowserShortcut,
  keyToShortcutToken,
  normalizeCombo,
  type ShortcutActionId,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

interface ShortcutRecordingDialogProps {
  action: CustomizableShortcutAction | null;
  actions: ReadonlyArray<CustomizableShortcutAction>;
  overrides: Record<string, string>;
  onSave: (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => void;
  onOpenChange: (open: boolean) => void;
}

function keyboardEventToCombo(event: React.KeyboardEvent<HTMLDivElement>): ShortcutCombo | null {
  if (MODIFIER_KEYS.has(event.key.toLowerCase())) return null;

  const key = keyToShortcutToken(event.key);
  if (!key) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(key);
  return normalizeCombo(parts.join('+'));
}

function modifierKeyUpToCombo(event: React.KeyboardEvent<HTMLDivElement>): ShortcutCombo | null {
  const key = event.key.toLowerCase();
  if (!MODIFIER_KEYS.has(key)) return null;

  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey || key === 'meta' || key === 'control') parts.push('mod');
  if (event.shiftKey || key === 'shift') parts.push('shift');
  if (event.altKey || key === 'alt') parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

export const ShortcutRecordingDialog: React.FC<ShortcutRecordingDialogProps> = ({
  action,
  actions,
  overrides,
  onSave,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const actionLabel = (shortcut: CustomizableShortcutAction) => t(shortcut.settingsLabelKey);
  const [chords, setChords] = React.useState<ShortcutCombo[]>([]);
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!action) return;
    setChords([]);
  }, [action]);

  const combo = normalizeCombo(chords.join(' '));
  const conflicts = React.useMemo(() => {
    if (!action || !combo) return [];
    const result: Array<{ action: CustomizableShortcutAction; kind: 'exact' | 'prefix' }> = [];
    for (const candidate of actions) {
      if (candidate.id === action.id) continue;
      const candidateCombo = candidate.id === 'switch_context_surface'
        ? getEffectiveShortcutPrefix(candidate.id, overrides)
        : getEffectiveShortcutCombo(candidate.id, overrides);
      const kind = getShortcutConflict(combo, candidateCombo);
      if (kind) result.push({ action: candidate, kind });
    }
    return result;
  }, [action, actions, combo, overrides]);
  const prefixConflict = conflicts.find((conflict) => conflict.kind === 'prefix');
  const exactConflict = conflicts.find((conflict) => conflict.kind === 'exact');

  const close = () => onOpenChange(false);

  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        initialFocus={recordingRef}
      >
        <DialogHeader>
          <DialogTitle>
            {action
              ? t('settings.openchamber.keyboardShortcuts.dialog.title', {
                  action: actionLabel(action),
                })
              : ''}
          </DialogTitle>
          <DialogDescription>{t('settings.openchamber.keyboardShortcuts.dialog.instructions')}</DialogDescription>
        </DialogHeader>

        <div
          className="space-y-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          ref={recordingRef}
          onKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();

            if (event.key === 'Escape') {
              close();
              return;
            }
            if (event.key === 'Backspace') {
              setChords((current) => current.slice(0, -1));
              return;
            }

            const chord = keyboardEventToCombo(event);
            if (chord) {
              setChords((current) => action?.id === 'switch_context_surface'
                ? [chord]
                : current.length < 2 ? [...current, chord] : current);
            }
          }}
          onKeyUp={(event) => {
            if (action?.id !== 'switch_context_surface' || chords.length > 0) return;
            const combo = modifierKeyUpToCombo(event);
            if (!combo) return;
            event.preventDefault();
            event.stopPropagation();
            setChords([combo]);
          }}
        >
          {[0, 1].map((index) => (
            <div key={index} className="flex items-center justify-between gap-3">
              <span className="typography-ui-label text-foreground">
                {t(index === 0
                  ? 'settings.openchamber.keyboardShortcuts.dialog.firstChord'
                  : 'settings.openchamber.keyboardShortcuts.dialog.secondChord')}
              </span>
              <kbd
                className="min-w-32 rounded-md border border-border bg-muted px-3 py-2 text-center typography-meta font-mono text-foreground"
              >
                {chords[index]
                  ? formatShortcutForDisplay(chords[index])
                  : t('settings.openchamber.keyboardShortcuts.dialog.recording')}
              </kbd>
            </div>
          ))}
          {prefixConflict ? (
            <p className="typography-meta text-[var(--status-error)]">
              {t('settings.openchamber.keyboardShortcuts.error.prefixConflict', { action: actionLabel(prefixConflict.action) })}
            </p>
          ) : null}
          {exactConflict && !prefixConflict ? (
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.openchamber.keyboardShortcuts.error.exactConflict', { action: actionLabel(exactConflict.action) })}
            </p>
          ) : null}
          {combo && isRiskyBrowserShortcut(combo) ? (
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut')}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            {t('settings.common.actions.cancel')}
          </Button>
          {exactConflict && !prefixConflict ? (
            <Button type="button" size="sm" onClick={() => {
              if (!action) return;
              onSave(action.id, combo, exactConflict.action.id);
              close();
            }}>
              {t('settings.openchamber.keyboardShortcuts.actions.replaceAndSave')}
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={!combo || Boolean(prefixConflict)} onClick={() => {
              if (!action) return;
              onSave(action.id, combo);
              close();
            }}>
              {t('settings.common.actions.saveChanges')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
