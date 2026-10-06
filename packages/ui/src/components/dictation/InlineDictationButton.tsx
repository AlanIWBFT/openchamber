/**
 * Dictation for a plain text field outside the composer (project notes and
 * todos): a mic button that turns into discard/insert while recording and a
 * spinner while the server transcribes. The transcript goes to `onTranscript`;
 * the host decides where it lands in its field.
 *
 * Unlike ComposerDictation there is no overlay and no global shortcut: the
 * toggle_dictation shortcut belongs to the chat composer, and a second listener
 * would start two recordings from one key press.
 */

import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useDictation } from '@/hooks/useDictation';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';

interface InlineDictationButtonProps {
  onTranscript: (text: string) => void;
  disabled?: boolean;
  /** Classes for each icon button, so the controls match the host's own. */
  buttonClassName: string;
  iconClassName?: string;
}

export const InlineDictationButton: React.FC<InlineDictationButtonProps> = ({
  onTranscript,
  disabled,
  buttonClassName,
  iconClassName = 'h-4 w-4',
}) => {
  const { t } = useI18n();
  const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
  // The dictation server lives in the OpenChamber web server; the VS Code
  // bridge has none.
  const [supported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());

  const onTranscriptRef = React.useRef(onTranscript);
  React.useEffect(() => {
    onTranscriptRef.current = onTranscript;
  }, [onTranscript]);

  const {
    status,
    error,
    partialTranscript,
    startDictation,
    confirmDictation,
    cancelDictation,
    discardFailedDictation,
  } = useDictation({
    onTranscript: (text) => {
      if (text.trim()) onTranscriptRef.current(text.trim());
    },
  });

  // No room here for the composer's salvage view: keep whatever was
  // transcribed before the failure, say it failed, and go back to idle.
  React.useEffect(() => {
    if (status !== 'failed') return;
    const salvage = partialTranscript.trim();
    if (salvage) onTranscriptRef.current(salvage);
    toast.error(t('chat.dictation.failed'), error ? { description: error } : undefined);
    discardFailedDictation();
  }, [discardFailedDictation, error, partialTranscript, status, t]);

  if (!supported || !dictationEnabled) {
    return null;
  }

  if (status === 'uploading') {
    return (
      <span className={cn(buttonClassName, 'pointer-events-none')} role="status" aria-label={t('chat.dictation.processing')} title={t('chat.dictation.processing')}>
        <Icon name="loader-4" className={cn(iconClassName, 'animate-spin')} />
      </span>
    );
  }

  if (status === 'recording') {
    return (
      <>
        <button
          type="button"
          onClick={() => void cancelDictation()}
          className={buttonClassName}
          aria-label={t('chat.dictation.cancel')}
          title={t('chat.dictation.cancel')}
        >
          <Icon name="close" className={iconClassName} />
        </button>
        <button
          type="button"
          onClick={() => void confirmDictation()}
          className={cn(buttonClassName, 'text-primary hover:text-primary')}
          aria-label={t('chat.dictation.insert')}
          title={t('chat.dictation.insert')}
        >
          {/* Opacity pulse: the only sign the mic is live while recording. */}
          <Icon name="check" className={cn(iconClassName, 'animate-pulse')} />
        </button>
      </>
    );
  }

  return (
    <button
      type="button"
      onClick={() => void startDictation()}
      disabled={disabled}
      className={buttonClassName}
      aria-label={t('chat.dictation.start')}
      title={t('chat.dictation.start')}
    >
      <Icon name="mic" className={iconClassName} />
    </button>
  );
};
