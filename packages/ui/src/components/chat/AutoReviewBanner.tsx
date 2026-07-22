import React, { memo } from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from './chatColumnSession';
import { stopSessionExecution } from '@/sync/session-actions';
import { toast } from '@/components/ui';

export const AutoReviewBanner = memo(() => {
  const { t } = useI18n();
  const currentSessionId = useChatSessionSelection().sessionId;
  const run = useAutoReviewStore(React.useCallback((state) => {
    if (!currentSessionId) return null;
    const run = state.runsByOriginalSessionID[currentSessionId] ?? null;
    return run?.runtimeKey === getRuntimeKey() ? run : null;
  }, [currentSessionId]));
  const stopRun = useAutoReviewStore((state) => state.stopRun);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const [stopping, setStopping] = React.useState(false);

  if (!currentSessionId || !run || run.status !== 'running') {
    return null;
  }

  const statusLabel = run.phase === 'waiting_for_reviewer'
    ? t('chat.autoReview.status.waitingForReviewer')
    : t('chat.autoReview.status.waitingForImplementer');

  const handleOpenReviewSession = () => {
    openContextPanelTab(run.directory, {
      mode: 'chat',
      dedupeKey: `session:${run.reviewSessionID}`,
      label: t('chat.autoReview.reviewSessionLabel'),
      readOnly: true,
    });
  };

  const handleStop = async () => {
    if (stopping) return;
    setStopping(true);
    stopRun(run.originalSessionID);
    try {
      await Promise.all([
        stopSessionExecution(run.originalSessionID, run.directory),
        stopSessionExecution(run.reviewSessionID, run.directory),
      ]);
    } catch (error) {
      console.error('[auto-review] stop failed', error);
      toast.error(error instanceof Error ? error.message : 'Failed to stop auto review');
    } finally {
      setStopping(false);
    }
  };

  return (
    <div className="pb-2 w-full px-1">
      {/* Shadow on the wrapper, never on the glass: see "Floating composer"
          in composer/DOCUMENTATION.md. */}
      <div className="rounded-xl shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]">
      <div className="oc-glass-popover w-full min-w-0 overflow-hidden rounded-xl border border-[var(--interactive-border)]">
        <div className="flex w-full items-center gap-2 px-3 py-2 text-left">
          <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <span className="typography-ui-label font-medium text-foreground">
              {t('chat.autoReview.title')}
              <BusyDots />
            </span>
            <div className="typography-meta text-muted-foreground">
              {statusLabel}
            </div>
          </div>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={handleOpenReviewSession}
          >
            {t('chat.autoReview.actions.open')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="xs"
            disabled={stopping}
            onClick={() => void handleStop()}
          >
            {t('chat.autoReview.actions.stop')}
          </Button>
        </div>
      </div>
      </div>
    </div>
  );
});

AutoReviewBanner.displayName = 'AutoReviewBanner';
