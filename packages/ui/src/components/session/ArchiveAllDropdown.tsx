import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

interface ArchiveAllDropdownProps {
  onArchiveAll?: () => void;
}

const ArchiveAllDropdown: React.FC<ArchiveAllDropdownProps> = ({ onArchiveAll }) => {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const requestArchiveAll = async () => {
    const confirmed = await confirm({
      title: t('vscodeLayout.actions.archiveAllConfirm'),
      message: t('sessions.sidebar.project.archiveAll.title'),
      action: t('sessions.sidebar.bulkActions.archive'),
    });
    if (confirmed) onArchiveAll?.();
  };
  return (
    <>
      <DropdownMenu>
        <Tooltip delayDuration={500}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center p-2 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t('vscodeLayout.actions.archiveAllAria')}
              >
                <Icon name="archive" className="h-5 w-5" />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}><p>{t('vscodeLayout.actions.archiveAllAria')}</p></TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="min-w-[160px]">
          <DropdownMenuItem onSelect={() => void requestArchiveAll()}>
            {t('vscodeLayout.actions.archiveAllConfirm')}
          </DropdownMenuItem>
          <DropdownMenuItem>{t('vscodeLayout.actions.cancel')}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
};

export { ArchiveAllDropdown };
