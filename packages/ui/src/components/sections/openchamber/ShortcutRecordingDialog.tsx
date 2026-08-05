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
  getShortcutBindingConflicts,
  isRiskyBrowserShortcut,
  keyToShortcutToken,
  normalizeCombo,
  type ShortcutActionId,
  type ShortcutBindingConflict,
  type ShortcutCombo,
  type CustomizableShortcutAction,
} from '@/lib/shortcuts';
import { useI18n } from '@/lib/i18n';

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta']);

interface RecordingKeyboardEvent {
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  repeat: boolean;
  shiftKey: boolean;
}

interface ShortcutRecordingState {
  chords: ShortcutCombo[];
  livePreview: ShortcutCombo | null;
}

interface ShortcutRecordingDialogProps {
  action: CustomizableShortcutAction | null;
  overrides: Record<string, string>;
  onSave: (
    actionId: ShortcutActionId,
    combo: ShortcutCombo,
    replaceActionId?: ShortcutActionId,
  ) => void;
  onOpenChange: (open: boolean) => void;
}

function isCustomizableConflict(
  conflict: ShortcutBindingConflict,
): conflict is ShortcutBindingConflict & { action: CustomizableShortcutAction } {
  return conflict.action.customizable;
}

function getModifierPreview(event: RecordingKeyboardEvent): ShortcutCombo | null {
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  return parts.length > 0 ? normalizeCombo(parts.join('+')) : null;
}

function keyboardEventToCombo(event: RecordingKeyboardEvent): ShortcutCombo | null {
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

// eslint-disable-next-line react-refresh/only-export-components -- tested pure recording state transition
export function updateShortcutRecordingState(
  state: ShortcutRecordingState,
  event: RecordingKeyboardEvent,
  phase: 'keydown' | 'keyup',
): ShortcutRecordingState {
  if (event.repeat || event.isComposing) return state;
  if (phase === 'keyup') {
    return { ...state, livePreview: getModifierPreview(event) };
  }

  if (event.key === 'Backspace') {
    return { chords: state.chords.slice(0, -1), livePreview: null };
  }

  const chord = keyboardEventToCombo(event);
  if (chord) {
    return {
      chords: state.chords.length < 2 ? [...state.chords, chord] : state.chords,
      livePreview: null,
    };
  }

  return { ...state, livePreview: getModifierPreview(event) };
}

export const ShortcutRecordingDialog: React.FC<ShortcutRecordingDialogProps> = ({
  action,
  overrides,
  onSave,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const actionLabel = (shortcut: CustomizableShortcutAction) => t(shortcut.settingsLabelKey);
  const [recording, setRecording] = React.useState<ShortcutRecordingState>({ chords: [], livePreview: null });
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!action) return;
    setRecording({ chords: [], livePreview: null });
    recordingRef.current?.focus();
  }, [action]);

  const combo = normalizeCombo(recording.chords.join(' '));
  const conflicts = React.useMemo(
    () => action && combo ? getShortcutBindingConflicts(action.id, combo, overrides) : [],
    [action, combo, overrides],
  );
  const protectedConflict = conflicts.find((conflict) => !conflict.action.customizable);
  const customizableConflicts = conflicts.filter(isCustomizableConflict);
  const prefixConflict = customizableConflicts.find((conflict) => conflict.kind === 'prefix');
  const exactConflict = customizableConflicts.find((conflict) => conflict.kind === 'exact');

  const close = () => onOpenChange(false);
  const confirm = () => {
    if (!action || !combo || protectedConflict || prefixConflict) return;
    onSave(action.id, combo, exactConflict?.action.id);
    close();
  };
  const handleRecordingEvent = (event: React.KeyboardEvent<HTMLDivElement>, phase: 'keydown' | 'keyup') => {
    event.preventDefault();
    event.stopPropagation();
    if (phase === 'keyup' && action?.id === 'switch_context_surface' && recording.chords.length === 0) {
      const modifierCombo = modifierKeyUpToCombo(event);
      if (modifierCombo) {
        setRecording({ chords: [modifierCombo], livePreview: null });
        return;
      }
    }
    const nextRecording = updateShortcutRecordingState(recording, {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
    }, phase);
    setRecording(action?.id === 'switch_context_surface' && nextRecording.chords.length > 1
      ? { ...nextRecording, chords: nextRecording.chords.slice(0, 1) }
      : nextRecording);
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={(open, eventDetails) => {
        if (!open) {
          eventDetails.cancel();
        }
      }}
    >
      <DialogContent className="max-w-md" initialFocus={recordingRef} showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>
            {action ? t('settings.openchamber.keyboardShortcuts.dialog.title', { action: actionLabel(action) }) : ''}
          </DialogTitle>
          <DialogDescription>{t('settings.openchamber.keyboardShortcuts.dialog.instructions')}</DialogDescription>
        </DialogHeader>

        <div
          className="flex min-h-28 items-center justify-center rounded-lg border border-border bg-[var(--surface-elevated)] px-4 py-5 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          ref={recordingRef}
          onKeyDown={(event) => handleRecordingEvent(event, 'keydown')}
          onKeyUp={(event) => handleRecordingEvent(event, 'keyup')}
          onBlur={() => setRecording((current) => ({ ...current, livePreview: null }))}
        >
          <div className="flex flex-wrap items-center justify-center gap-2">
            {recording.chords.map((chord, index) => (
              <kbd key={`${chord}-${index}`} className="rounded-md border border-border bg-muted px-3 py-2 typography-ui-label font-mono text-foreground">
                {formatShortcutForDisplay(chord)}
              </kbd>
            ))}
            {recording.livePreview ? (
              <kbd className="rounded-md border border-dashed border-border bg-muted px-3 py-2 typography-ui-label font-mono text-muted-foreground">
                {formatShortcutForDisplay(recording.livePreview)}
              </kbd>
            ) : null}
            {recording.chords.length === 0 && !recording.livePreview ? (
              <span className="typography-ui-label text-muted-foreground">
                {t('settings.openchamber.keyboardShortcuts.dialog.recording')}
              </span>
            ) : null}
          </div>
        </div>

        {protectedConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.internalConflict')}
          </p>
        ) : prefixConflict ? (
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.openchamber.keyboardShortcuts.error.prefixConflict', { action: actionLabel(prefixConflict.action) })}
          </p>
        ) : null}
        {exactConflict && !protectedConflict && !prefixConflict ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.error.exactConflict', { action: actionLabel(exactConflict.action) })}
          </p>
        ) : null}
        {combo && isRiskyBrowserShortcut(combo) ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.openchamber.keyboardShortcuts.warning.riskyBrowserShortcut')}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={close}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!combo || Boolean(protectedConflict) || Boolean(prefixConflict)}
            onClick={confirm}
          >
            {t('settings.openchamber.keyboardShortcuts.actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
