import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { countExplorationTools } from './toolRenderUtils';

interface ExplorationDisclosureProps {
    id: string;
    counts: ReturnType<typeof countExplorationTools>;
    isExpanded: boolean;
    onToggle: (id: string) => void;
    children: React.ReactNode;
}

/** Shared disclosure for turn-level exploration and the same calls inside Script. */
export const ExplorationDisclosure = React.memo(({ id, counts, isExpanded, onToggle, children }: ExplorationDisclosureProps) => {
    const { t } = useI18n();
    const contentId = `${id}-content`;
    const summary = counts.search > 0 && counts.read > 0
        ? t('chat.activity.exploration.summary.searchesAndReads', { searchCount: counts.search, readCount: counts.read })
        : counts.search > 0
            ? t('chat.activity.exploration.summary.searches', { searchCount: counts.search })
            : t('chat.activity.exploration.summary.reads', { readCount: counts.read });
    const handleToggle = React.useCallback(() => onToggle(id), [id, onToggle]);
    return (
        <div data-exploration-group={id} className="min-w-0">
            <button type="button" aria-expanded={isExpanded} aria-controls={contentId} onClick={handleToggle}
                className="group/tool flex w-full min-w-0 items-center gap-1.5 rounded-xl py-1.5 pl-px pr-2 text-left">
                <div className="flex flex-shrink-0 items-center gap-1.5">
                    <div className="relative size-3.5 flex-shrink-0">
                        <div className={cn('absolute inset-0 transition-opacity', isExpanded && 'opacity-0', !isExpanded && 'group-hover/tool:opacity-0')}
                            style={{ color: 'var(--tools-icon)' }}>
                            <Icon name="search" className="size-3.5" />
                        </div>
                        <div className={cn('absolute inset-0 flex items-center justify-center transition-opacity',
                            isExpanded && 'opacity-100', !isExpanded && 'opacity-0 group-hover/tool:opacity-100')}
                            style={{ color: 'var(--tools-icon)' }}>
                            <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                        </div>
                    </div>
                    <span className="typography-meta font-medium !text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal"
                        style={{ color: 'var(--tools-title)' }}>{t('chat.activity.exploration')}</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-1 typography-meta !text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal"
                    style={{ color: 'var(--tools-description)' }}>
                    <span className="min-w-0 truncate opacity-80" title={summary}>{summary}</span>
                </div>
            </button>
            {isExpanded ? (
                <div id={contentId} className="relative ml-2 pb-1 pl-3 pt-0.5">
                    <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0 top-0 w-px" style={{ backgroundColor: 'var(--tools-border)' }} />
                    {children}
                </div>
            ) : null}
        </div>
    );
});
