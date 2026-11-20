import React from 'react';
import { Button } from '@/components/ui/button';
import { DiffCount } from '@/components/ui/diff-count';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { hiddenToolCount, type ToolSegment } from '../lib/turns/toolSegments';
import { SegmentContext } from './toolSegmentContext';

export function ToolSegmentDisclosure({ segment, selectionKey }: { segment: ToolSegment; selectionKey?: string | null }) {
    const context = React.useContext(SegmentContext);
    const { t } = useI18n();
    const header = React.useRef<HTMLButtonElement>(null);
    const hidden = hiddenToolCount(segment, context?.preview);
    if (!context || !hidden) return null;
    const expanded = context.expanded(segment.id);
    const summary = segment.summary;
    const fileLabel = summary.files ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files }) : '';
    const details = [
        summary.explored && t('chat.liveActivity.explored'),
        summary.commands && t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }),
        summary.researched && t('chat.liveActivity.researched'),
        summary.subagents && t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }),
    ].filter(Boolean).join(' · ');
    const running = summary.runningCommands ? t('chat.liveActivity.runningCommands', { count: summary.runningCommands }) : '';
    const showMore = !expanded && segment === context.preview && hidden < segment.rows.length;
    const fallback = !fileLabel && !details && !running;
    const handleToggle = (event: React.MouseEvent<HTMLButtonElement>) => {
        if (!expanded) dispatchRowExpand(event.currentTarget);
        if (event.detail === 0 && event.currentTarget !== header.current) header.current?.focus({ preventScroll: true });
        context.toggle([segment.id], !expanded);
    };
    return <>
        <Button ref={header} type="button" variant="ghost" size="sm" aria-expanded={expanded}
            data-message-select-unit={selectionKey ?? undefined} data-tool-segment={segment.id} className="mt-2 w-full min-w-0 justify-start normal-case !ps-px !pe-2 hover:!bg-transparent active:!bg-transparent"
            onClick={handleToggle}>
            <Icon name="stack" className="size-3.5 shrink-0 text-[var(--tools-icon)]" />
            {!fallback ? <span className="sr-only">{t('chat.liveActivity.title')}</span> : null}
            <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0 rtl:-scale-x-100" />
            {fallback ? <span className="typography-meta">{t('chat.liveActivity.segment', { count: segment.rows.length })}</span> : null}
            {running ? <span role="status" className="min-w-0 truncate typography-meta">{running}</span> : null}
            {fileLabel || details ? <span className="min-w-0 flex-1 truncate text-start typography-meta" title={[fileLabel, details].filter(Boolean).join(' · ')}>
                {fileLabel}
                {fileLabel && summary.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0)
                    ? <> <DiffCount added={summary.additions} removed={summary.deletions} /></> : null}
                {fileLabel && details ? ' · ' : ''}{details}
            </span> : null}
        </Button>
        {showMore ? <div data-message-select-unit={selectionKey ?? undefined}>
            <Button type="button" variant="ghost" size="xs" onClick={handleToggle} aria-expanded={false}
                className="typography-meta font-normal normal-case text-muted-foreground/45 hover:text-muted-foreground/65 hover:bg-transparent">
                {t('chat.liveActivity.moreRows', { count: hidden })}
            </Button>
        </div> : null}
    </>;
}
