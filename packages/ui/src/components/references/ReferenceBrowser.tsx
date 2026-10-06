/** The parts of the reference list both the picker and the board lay out; state lives in `useReferenceBrowser`. */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { ReferencePickerRow } from './ReferencePickerRow';
import {
    FILTER_LABEL_KEYS,
    GITHUB_FILTERS,
    LINEAR_FILTERS,
    referencePickerItemKey,
    type ReferencePickerItem,
} from './referencePickerItems';
import { readyValue, type ReferenceBrowser } from './useReferenceBrowser';

/** Issues and pull requests (merge requests on GitLab); GitHub only. */
export const ReferenceBrowserTabs: React.FC<{ browser: ReferenceBrowser }> = ({ browser }) => {
    const { t } = useI18n();
    if (browser.source !== 'github') return null;
    return (
        <div className={cn(browser.isMobile ? 'w-full' : 'w-[16rem]')}>
            <SortableTabsStrip
                items={[
                    { id: 'issue', label: t('references.picker.tab.issues'), icon: <Icon name="record-circle" className="size-3.5" /> },
                    { id: 'pull', label: t(browser.isGitLab ? 'references.picker.tab.mergeRequests' : 'references.picker.tab.pulls'), icon: <Icon name="git-pull-request" className="size-3.5" /> },
                ]}
                activeId={browser.githubKind}
                onSelect={(id) => browser.selectGitHubKind(id === 'pull' ? 'pull' : 'issue')}
                variant="active-pill"
                layoutMode="fit"
            />
        </div>
    );
};

/** The search field and the filter chips beside it. */
export const ReferenceBrowserSearch: React.FC<{
    browser: ReferenceBrowser;
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ browser, onKeyDown }) => {
    const { t } = useI18n();
    const { source, isGitLab, isMobile, list, query, searchRef } = browser;
    const filters = source === 'github'
        ? (isGitLab ? [] : GITHUB_FILTERS[browser.githubKind]).map((filter) => ({
            id: filter,
            label: t(FILTER_LABEL_KEYS[filter]),
            active: browser.githubFilter === filter,
            select: () => browser.selectGitHubFilter(filter),
        }))
        : LINEAR_FILTERS.map((filter) => ({
            id: filter,
            label: t(FILTER_LABEL_KEYS[filter]),
            active: browser.linearFilter === filter,
            select: () => browser.selectLinearFilter(filter),
        }));
    const placeholder = t(source === 'linear' ? 'references.picker.search.linear' : isGitLab ? 'references.picker.search.gitlab' : 'references.picker.search.github');

    return (
        <div className={cn('flex gap-2', isMobile ? 'flex-col' : 'min-w-0 flex-1 items-center')}>
            {/* Desktop: shares a row with the title or the tabs, so the field gives way first when it runs short. */}
            <div className={cn('relative', isMobile ? 'w-full' : 'min-w-[10rem] max-w-[18rem] flex-1')}>
                <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                    ref={searchRef}
                    autoFocus={!isMobile}
                    value={query}
                    onChange={(event) => browser.setQuery(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={placeholder}
                    aria-label={placeholder}
                    className="h-9 w-full pl-9 pr-14"
                />
                <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-1">
                    {list.refreshing && list.status !== 'loading' ? (
                        <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" />
                    ) : null}
                    {query ? (
                        <button
                            type="button"
                            onClick={() => {
                                browser.setQuery('');
                                searchRef.current?.focus();
                            }}
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
                            aria-label={t('references.picker.actions.clearSearch')}
                            title={t('references.picker.actions.clearSearch')}
                        >
                            <Icon name="close" className="size-3.5" />
                        </button>
                    ) : null}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
                {filters.map((filter) => (
                    <Button
                        key={filter.id}
                        type="button"
                        variant="chip"
                        size="sm"
                        // As tall as the search field beside it.
                        className="h-9"
                        aria-pressed={filter.active}
                        onClick={filter.select}
                    >
                        {filter.label}
                    </Button>
                ))}
            </div>
        </div>
    );
};

/** What a row adds on a surface that checks items; a board row has none of it. */
type ReferenceBrowserRowSelection = {
    /** Null where rows have no checkbox. */
    checked: boolean | null;
    diffIncluded: boolean;
    onToggle: () => void;
};

/** The list with its loading, failure, empty and not-connected states. */
export const ReferenceBrowserList: React.FC<{
    browser: ReferenceBrowser;
    label: string;
    multiselectable: boolean;
    onOpenSettings: () => void;
    rowSelection?: (item: ReferencePickerItem, key: string) => ReferenceBrowserRowSelection;
    onActivate?: (item: ReferencePickerItem) => void;
}> = ({ browser, label, multiselectable, onOpenSettings, rowSelection, onActivate }) => {
    const { t } = useI18n();
    const { source, sourceStatus, list, items, isGitLab, isMobile, directory, debouncedQuery, githubKind } = browser;

    // Load the next page when the end of the list scrolls into view.
    const sentinelRef = React.useRef<HTMLDivElement>(null);
    const { hasMore, loadMore } = list;
    React.useEffect(() => {
        const sentinel = sentinelRef.current;
        if (!sentinel || !hasMore) return;
        const observer = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) loadMore();
        }, { rootMargin: '200px' });
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [hasMore, loadMore, items.length]);

    const centered = (children: React.ReactNode) => (
        <div className="flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 px-6 py-10 text-center typography-meta text-muted-foreground">
            {children}
        </div>
    );
    const emptyText = () => {
        if (debouncedQuery.trim()) return t('references.picker.empty.search');
        if (source === 'linear') return t('references.picker.empty.linear');
        if (githubKind === 'issue') return t('references.picker.empty.issues');
        return t(isGitLab ? 'references.picker.empty.mergeRequests' : 'references.picker.empty.pulls');
    };

    if (sourceStatus === 'unsupported') return centered(t('references.picker.empty.unsupported'));
    if (sourceStatus === 'disconnected' || list.unavailable === 'disconnected') {
        return centered(
            <>
                <span>{t(source === 'linear'
                    ? 'references.picker.empty.linear.notConnected'
                    : isGitLab ? 'references.picker.empty.gitlab.notConnected' : 'references.picker.empty.github.notConnected')}</span>
                <Button size="sm" variant="outline" onClick={onOpenSettings}>{t('references.picker.actions.openSettings')}</Button>
            </>,
        );
    }
    if (source === 'github' && !directory) return centered(t('references.picker.empty.noProject'));
    if (list.unavailable === 'no-repo') return centered(t('references.picker.empty.noRepo'));
    if (list.status === 'loading') {
        return centered(
            <span className="inline-flex items-center gap-2">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('references.picker.loading')}
            </span>,
        );
    }
    if (list.status === 'error') {
        return centered(
            <>
                <span className="break-words text-[var(--status-error-text)]">{t('references.picker.error.load', { error: list.error ?? '' })}</span>
                <Button size="sm" variant="outline" onClick={list.retry}>{t('references.picker.actions.retry')}</Button>
            </>,
        );
    }
    return (
        <div role="listbox" aria-label={label} aria-multiselectable={multiselectable} className="flex flex-col gap-1 p-1.5">
            {list.error ? (
                <div className="mb-1 flex items-center gap-2 rounded-lg bg-[var(--status-error-background)] px-2.5 py-1.5 typography-meta text-[var(--status-error-text)]">
                    <span className="min-w-0 flex-1 break-words">{t('references.picker.error.refresh', { error: list.error })}</span>
                    <Button size="xs" variant="ghost" onClick={list.retry}>{t('references.picker.actions.retry')}</Button>
                </div>
            ) : null}
            {items.length === 0 ? centered(emptyText()) : null}
            {items.map((item) => {
                const key = referencePickerItemKey(item);
                const selection = rowSelection?.(item, key) ?? null;
                return (
                    <ReferencePickerRow
                        key={key}
                        item={item}
                        pullStatus={item.source === 'github' ? readyValue(browser.pullStatusOf(item.reference)) : null}
                        highlighted={!isMobile && key === browser.effectiveHighlightKey}
                        checked={selection?.checked ?? null}
                        diffIncluded={selection?.diffIncluded ?? false}
                        now={browser.now}
                        onHighlight={() => browser.showItem(key)}
                        onToggle={() => selection?.onToggle()}
                        onActivate={() => onActivate?.(item)}
                    />
                );
            })}
            {list.hasMore ? (
                <div ref={sentinelRef} className="flex justify-center py-3">
                    {list.loadingMore ? <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" /> : null}
                </div>
            ) : null}
        </div>
    );
};
