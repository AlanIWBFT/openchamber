import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getRunningCommandMessages, getShownPages, projectLiveActivityPreview } from '../lib/turns/liveActivity';
import AssistantTextPart from '../message/parts/AssistantTextPart';
import type { StreamPhase } from '../message/types';
import { LiveTurnHoistedCommandsContext } from './liveActivityContext';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { ShownPartCard } from '../message/parts/ShownToolCard';
import { useActivityRowGlide, useLiveRowsFloor } from './useActivityRowGlide';
import { foldContentId, finalActivityContentId, useTurnFold } from './useTurnFold';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { renderedPage } from '@/lib/opencode/tools';
import type { ShownPart } from '../lib/turns/liveActivity';

interface TurnFoldProps {
    turn: TurnRecord;
    hasLaterAssistant: boolean;
    expanded: boolean;
    isWorking: boolean;
    streamingMessageId?: string | null;
    streamPhase?: StreamPhase | null;
    finalMessageId: string | undefined;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/**
 * The fold's header. Folded, it also draws what stays in view: a working
 * turn's latest steps, then the pages it showed and the steps after them.
 */
export function TurnFold({ turn, hasLaterAssistant, expanded, isWorking, streamingMessageId, streamPhase, finalMessageId, onToggle, renderMessage }: TurnFoldProps) {
    const { t } = useI18n();
    const { finalMessage, activityMessages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    const isRunning = isWorking && !finalMessage;
    const settled = !isRunning;
    const [showTouchHint, setShowTouchHint] = React.useState(false);
    const touchActivation = React.useRef(false);
    const hintTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (hintTimeout.current !== null) clearTimeout(hintTimeout.current);
    }, []);
    const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        touchActivation.current = event.pointerType === 'touch';
    }, []);
    // Folded, a working turn shows only its latest rows (the header counts
    // the earlier ones) and a settled one shows none.
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const preview = React.useMemo(() => expanded ? null
        : projectLiveActivityPreview({ ...turn, assistantMessages: activityMessages }, showReasoningTraces),
    [turn, activityMessages, expanded, showReasoningTraces]);
    const commandRows = React.useMemo(() => {
        if (expanded || (isRunning && !preview?.hiddenCount)) return null;
        const messages = getRunningCommandMessages(turn.assistantMessages, isRunning ? new Set(preview?.hiddenRowIds) : undefined);
        if (!messages.length) return null;
        const ids = new Set(messages.flatMap((message) => message.parts.map((part) => part.id)));
        return { messages, ids, hiddenCount: preview?.hiddenRowIds.filter((id) => !ids.has(id)).length ?? 0 };
    }, [expanded, isRunning, preview, turn.assistantMessages]);
    const hiddenRows = commandRows?.hiddenCount ?? preview?.hiddenCount ?? 0;
    const rowsRef = React.useRef<HTMLDivElement>(null);
    const previewFloorRef = React.useRef<HTMLDivElement>(null);
    const previewRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, hiddenRows, !settled && !expanded);
    useLiveRowsFloor(previewFloorRef, previewRef, !settled && !expanded);
    // No diff parsing at token frequency. The report is only shown once the
    // turn settles; later authoritative tool metadata can refine it.
    const summary = React.useMemo(() => settled ? summarizeLiveActivity(turn.assistantMessages) : null,
        [settled, turn.assistantMessages]);
    const fileLabel = summary && summary.files > 0
        ? t(summary.files === 1 ? 'chat.liveActivity.changedFile' : 'chat.liveActivity.changedFiles', { count: summary.files })
        : null;
    const details = summary ? [
        summary.explored ? t('chat.liveActivity.explored') : null,
        summary.commands > 0 ? t(summary.commands === 1 ? 'chat.liveActivity.ranCommand' : 'chat.liveActivity.ranCommands', { count: summary.commands }) : null,
        summary.researched ? t('chat.liveActivity.researched') : null,
        summary.subagents > 0 ? t(summary.subagents === 1 ? 'chat.liveActivity.usedSubagent' : 'chat.liveActivity.usedSubagents', { count: summary.subagents }) : null,
    ].filter(Boolean).join(' · ') : '';
    const label = (
        <>
            <span className="relative size-3.5 shrink-0 text-[var(--tools-icon)]">
                <span className={cn('absolute inset-0 transition-opacity', expanded ? 'opacity-0' : 'group-hover/tool:opacity-0')}>
                    <Icon name="stack" className="size-3.5" />
                </span>
                <span className={cn('absolute inset-0 transition-opacity', expanded ? 'opacity-100' : 'opacity-0 group-hover/tool:opacity-100')}>
                    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5" />
                </span>
            </span>
            <span className="shrink-0 font-semibold text-[var(--tools-title)]">{t('chat.liveActivity.title')}</span>
            {isRunning ? (
                <span aria-hidden="true" data-live-activity-view-hint="true"
                    className={cn('grid min-w-0 flex-1 text-start typography-meta text-[var(--tools-description)] transition-opacity group-hover/tool:opacity-100 motion-reduce:transition-none',
                        showTouchHint ? 'opacity-100' : 'opacity-0')}>
                    <span className={cn('col-start-1 row-start-1 truncate transition-opacity motion-reduce:transition-none', expanded ? 'opacity-0' : 'opacity-100')}>
                        {t('chat.liveActivity.latestActivity')}
                    </span>
                    <span className={cn('col-start-1 row-start-1 truncate transition-opacity motion-reduce:transition-none', expanded ? 'opacity-100' : 'opacity-0')}>
                        {t('chat.liveActivity.allActivity')}
                    </span>
                </span>
            ) : null}
            {summary && summary.runningCommands > 0 ? (
                <span className="shrink-0 typography-meta text-[var(--tools-description)]" role="status">
                    {t('chat.liveActivity.runningCommands', { count: summary.runningCommands })}
                </span>
            ) : null}
            {fileLabel ? (
                <span className="flex min-w-0 items-center gap-1 typography-meta @min-[560px]:shrink-0">
                    <span className="truncate">{fileLabel}</span>
                    {summary?.hasCompleteDiff && (summary.additions > 0 || summary.deletions > 0) ? (
                        <span className="shrink-0 tabular-nums">
                            <span className="text-[var(--status-success)]">+{summary.additions}</span>
                            <span aria-hidden="true">/</span>
                            <span className="text-[var(--status-error)]">-{summary.deletions}</span>
                        </span>
                    ) : null}
                </span>
            ) : null}
            {details ? <span className="hidden min-w-0 flex-1 truncate text-start typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
        </>
    );
    // The fold opens below its header, which stays where the reader clicked it.
    const handleToggle = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        if (isRunning && touchActivation.current && event.detail > 0) {
            if (hintTimeout.current !== null) clearTimeout(hintTimeout.current);
            setShowTouchHint(true);
            hintTimeout.current = setTimeout(() => {
                hintTimeout.current = null;
                setShowTouchHint(false);
            }, 1200);
        }
        touchActivation.current = false;
        if (!expanded && !isRunning) dispatchRowExpand(event.currentTarget);
        onToggle();
    }, [expanded, isRunning, onToggle]);
    const headerClass = 'group/tool w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    const contentId = foldContentId(turn.turnId);
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            <div className="chat-message-column @container">
                <div className="mt-1">
                    <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle} onPointerDown={handlePointerDown}
                        aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalActivityContentId(turn.turnId)}` : contentId}>
                        {label}
                    </Button>
                </div>
            </div>
            {isRunning && hiddenRows > 0 ? (
                <div className="chat-message-column">
                    <Button variant="ghost" size="xs" onClick={handleToggle} onPointerDown={handlePointerDown} aria-expanded={false} aria-controls={contentId}
                        data-live-activity-more="true"
                        className="typography-meta font-normal normal-case text-muted-foreground/45 hover:text-muted-foreground/65 hover:bg-transparent">
                        {t('chat.liveActivity.more', { count: hiddenRows })}
                    </Button>
                </div>
            ) : null}
            {expanded ? null : (
                <div ref={previewFloorRef}>
                    <div ref={previewRef}>
                        {commandRows ? <div data-live-activity-running-commands="true">
                            {commandRows.messages.map((message) => <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>)}
                        </div> : null}
                        <LiveTurnHoistedCommandsContext.Provider value={commandRows?.ids ?? null}>
                            <LiveActivityCollapse expanded={isRunning} id={contentId}>
                                <div ref={rowsRef}>
                                    {preview?.messages.map((message) => <React.Fragment key={message.info.id}>{renderMessage(message)}</React.Fragment>)}
                                </div>
                            </LiveActivityCollapse>
                        </LiveTurnHoistedCommandsContext.Provider>
                        {isRunning && preview?.pinnedText ? (
                            <div className="chat-message-column" data-pinned-activity-text={preview.pinnedText.part.id}>
                                <div aria-hidden="true" className="mt-1.5 mb-3 h-px w-full bg-border" />
                                <AssistantTextPart part={preview.pinnedText.part} messageId={preview.pinnedText.message.info.id}
                                    streamPhase={streamingMessageId === preview.pinnedText.message.info.id ? streamPhase ?? 'completed' : 'completed'} />
                            </div>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}

/** The pages a turn's agent showed, while the turn has no answer to draw them above. */
function TurnPages({ pages }: { pages: ReturnType<typeof getShownPages> }) {
    return (
        <div className="chat-message-column">
            {pages.map((part) => <TurnPage key={part.id} part={part} />)}
        </div>
    );
}

function TurnPage({ part }: { part: ShownPart }) {
    const page = part.type === 'tool' ? renderedPage(part.tool, part.state) : null;
    if (!page?.ui || page.ask.kind !== 'show') return <ShownPartCard part={part} />;
    return (
        <div data-ui-render-hoisted="true">
            <ShownPartCard part={part} />
        </div>
    );
}

/** The pages row of an opened fold. */
export function TurnPagesRow({ turn, pageId }: { turn: TurnRecord; pageId?: string }) {
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages).filter((part) => !pageId || part.id === pageId), [turn.assistantMessages, pageId]);
    return pages.length > 0 ? <TurnPages pages={pages} /> : null;
}
