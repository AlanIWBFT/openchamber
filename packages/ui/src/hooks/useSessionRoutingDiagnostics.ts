import { useEffect } from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeModelCacheIncidents } from '@/lib/diagnostics/session-routing';
import { useUIStore } from '@/stores/useUIStore';

/** The main web/desktop layout owns the diagnostic dialog. */
export function useSessionRoutingDiagnostics(): void {
  const { t } = useI18n();
  useEffect(() => subscribeModelCacheIncidents((incident) => {
    toast.warning(t('chat.sessionNotice.cacheMismatch'), {
      id: `session-routing:${incident.reference}`,
      duration: Infinity,
      description: t('chat.sessionNotice.cacheMismatchDescription'),
      action: {
        label: t('commandPalette.item.showOpenCodeStatus'),
        onClick: () => {
          const ui = useUIStore.getState();
          ui.setOpenCodeStatusText(incident.text);
          ui.setOpenCodeStatusDialogOpen(true);
        },
      },
    });
  }), [t]);
}
