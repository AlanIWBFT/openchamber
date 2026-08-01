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

type ShortcutRecordingAction = 'cancel' | 'none' | 'save';

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
): { action: ShortcutRecordingAction; state: ShortcutRecordingState } {
  if (event.repeat || event.isComposing) return { action: 'none', state };
  if (phase === 'keyup') {
    return { action: 'none', state: { ...state, livePreview: getModifierPreview(event) } };
  }

  if (event.key === 'Escape') return { action: 'cancel', state };
  if (event.key === 'Enter') return { action: 'save', state };
  if (event.key === 'Backspace') {
    return { action: 'none', state: { chords: state.chords.slice(0, -1), livePreview: null } };
  }

  const chord = keyboardEventToCombo(event);
  if (chord) {
    return {
      action: 'none',
      state: {
        chords: state.chords.length < 2 ? [...state.chords, chord] : state.chords,
        livePreview: null,
      },
    };
  }

  return { action: 'none', state: { ...state, livePreview: getModifierPreview(event) } };
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
  const [recording, setRecording] = React.useState<ShortcutRecordingState>({ chords: [], livePreview: null });
  const recordingRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!action) return;
    setRecording({ chords: [], livePreview: null });
    recordingRef.current?.focus();
  }, [action]);

  const combo = normalizeCombo(recording.chords.join(' '));
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
  const save = () => {
    if (!action || !combo || prefixConflict || exactConflict) return;
    onSave(action.id, combo);
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
    const result = updateShortcutRecordingState(recording, {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
    }, phase);
    setRecording(action?.id === 'switch_context_surface' && result.state.chords.length > 1
      ? { ...result.state, chords: result.state.chords.slice(0, 1) }
      : result.state);
    if (result.action === 'cancel') close();
    if (result.action === 'save') save();
  };

  return (
    <Dialog open={action !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" initialFocus={recordingRef}>
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

        {exactConflict && !prefixConflict ? (
          <DialogFooter>
            <Button type="button" size="sm" onClick={() => {
              if (!action) return;
              onSave(action.id, combo, exactConflict.action.id);
              close();
            }}>
              {t('settings.openchamber.keyboardShortcuts.actions.replaceAndSave')}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
