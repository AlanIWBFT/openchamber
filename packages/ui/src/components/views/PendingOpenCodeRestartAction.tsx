import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { applyPendingOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import {
  selectPendingOpenCodeRestartCount,
  usePendingOpenCodeRestartStore,
} from '@/stores/usePendingOpenCodeRestartStore';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';

type PendingOpenCodeRestartActionProps = {
  className?: string;
  compact?: boolean;
};

export const PendingOpenCodeRestartAction: React.FC<PendingOpenCodeRestartActionProps> = ({
  className,
  compact = false,
}) => {
  const { t } = useI18n();
  const pendingCount = usePendingOpenCodeRestartStore(selectPendingOpenCodeRestartCount);
  const isApplying = usePendingOpenCodeRestartStore((state) => state.isApplying);

  const handleApply = React.useCallback(async () => {
    try {
      const result = await applyPendingOpenCodeRestart({
        message: t('settings.view.pendingRestart.applying'),
      });
      if (result.requiresManualRestart) {
        toast.warning(t('settings.view.pendingRestart.manualRestartRequired'));
        return;
      }
      if (result.ok) {
        toast.success(t('settings.view.pendingRestart.applied'));
      }
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : t('settings.view.pendingRestart.applyFailed');
      toast.error(message);
    }
  }, [t]);

  if (pendingCount <= 0) {
    return null;
  }

  const tooltip = pendingCount === 1
    ? t('settings.view.actions.applyAndRestartOpenCodeTooltipSingle')
    : t('settings.view.actions.applyAndRestartOpenCodeTooltipPlural', { count: pendingCount });

  return (
    <Button
      type="button"
      size={compact ? 'xs' : 'sm'}
      disabled={isApplying}
      title={tooltip}
      aria-label={tooltip}
      onClick={() => void handleApply()}
      className={cn('gap-1.5 shadow-sm', className)}
    >
      <Icon name="restart" className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {isApplying
          ? t('settings.view.pendingRestart.applying')
          : t('settings.view.actions.applyAndRestartOpenCode')}
      </span>
      <span
        className={cn(
          'inline-flex min-w-5 items-center justify-center rounded-md px-1.5 typography-micro font-semibold',
          'bg-primary-foreground/15 text-primary-foreground',
        )}
        aria-hidden="true"
      >
        {pendingCount}
      </span>
    </Button>
  );
};
