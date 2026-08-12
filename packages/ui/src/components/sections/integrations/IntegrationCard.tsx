import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

interface IntegrationCardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  header: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  settingsItem?: string;
}

/**
 * Shared chrome for an integration summary and its on-demand configuration.
 * Header actions sit beside—not inside—the expansion button so their native
 * controls preserve their own keyboard and click behavior.
 */
export const IntegrationCard: React.FC<IntegrationCardProps> = ({
  open,
  onOpenChange,
  header,
  headerAction,
  children,
  className,
  contentClassName,
  settingsItem,
}) => {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        data-settings-item={settingsItem}
        className={cn(
          'overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-sm',
          className,
        )}
      >
        <div className="flex min-w-0 items-center">
          <button
            type="button"
            aria-expanded={open}
            onClick={() => onOpenChange(!open)}
            className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
          >
            {header}
            <Icon
              name={open ? 'arrow-up-s' : 'arrow-down-s'}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </button>
          {headerAction ? <div className="shrink-0 pr-4">{headerAction}</div> : null}
        </div>
        <CollapsibleContent
          className={cn('border-t border-[var(--interactive-border)] px-4 py-4', contentClassName)}
        >
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};
