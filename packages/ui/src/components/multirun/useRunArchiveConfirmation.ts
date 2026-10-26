import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { useI18n } from '@/lib/i18n';

/** A whole run always asks; the ordinary session archive preference does not apply. */
export function useRunArchiveConfirmation() {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const confirmArchive = (label: string): Promise<boolean> => confirm({
    title: t('multirun.overview.archive.action'),
    message: t('multirun.overview.archive.confirmMessage', { label }),
    action: t('sessions.sidebar.bulkActions.archive'),
  });
  return { confirmArchive, dialog };
}
