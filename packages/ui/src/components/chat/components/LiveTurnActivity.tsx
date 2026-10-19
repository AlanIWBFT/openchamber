import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage, getRunningCommandMessages, getShownPages, projectLiveActivityPreview, splitLiveActivityAtPages } from '../lib/turns/liveActivity';
import type { ToolPart } from '@/lib/opencode/model';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import AssistantTextPart from '../message/parts/AssistantTextPart';
import type { StreamPhase } from '../message/types';
import { cn } from '@/lib/utils';
import { TurnMessageWindow } from './TurnMessageWindow';
import { LiveActivityCollapse } from './LiveActivityCollapse';
import { LiveFinalActivityContext, LiveTurnHoistedCommandsContext, LiveTurnHoistedPagesContext } from './liveActivityContext';
import { ShownToolCard } from '../message/parts/ShownToolCard';
import { useActivityRowGlide } from './useActivityRowGlide';
import { TurnMessageWindowContext, initialMessageWindow, openedFoldMessageWindow } from '../lib/turns/turnMessageWindow';
import { dispatchRowExpand } from '../lib/scroll/timelineScrollIntent';
import { activityRowParts, createActivityRowPredicate } from '../lib/turns/activityRows';

interface LiveTurnActivityProps {
    turn: TurnRecord;
    expanded: boolean;
    isWorking: boolean;
    streamingMessageId?: string | null;
    streamPhase: StreamPhase;
    showReasoning: boolean;
    onToggle: () => void;
    segmentExpansion?: ReadonlyMap<string, boolean>;
    defaultExpanded?: boolean;
    onToggleSegment?: (id: string) => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function LiveTurnActivity(props: LiveTurnActivityProps) {
    const { turn, segmentExpansion, onToggleSegment } = props;
    const segments = React.useMemo(() => splitLiveActivityAtPages(turn), [turn]);
    if (getLiveFinalMessage(turn.assistantMessages) || !segments.some((segment) => segment.page)) return <ActivitySegment {...props} />;
    return <>{segments.map((segment) => (
        <ActivitySegment {...props} key={segment.id} segmented page={segment.page}
            turn={{ ...turn, turnId: segment.id, assistantMessages: segment.messages }}
            expanded={segmentExpansion?.get(segment.id) ?? (segment.id === turn.turnId ? props.expanded : props.defaultExpanded ?? false)}
            onToggle={() => onToggleSegment ? onToggleSegment(segment.id) : props.onToggle()} />
    ))}</>;
}

function ActivitySegment({ turn, expanded, isWorking, streamingMessageId, streamPhase, showReasoning, onToggle, renderMessage, segmented, page }: LiveTurnActivityProps & { segmented?: boolean; page?: ToolPart }) {
    const { t } = useI18n();
    const contentId = React.useId();
    const finalContentId = React.useId();
    const [showTouchHint, setShowTouchHint] = React.useState(false);
    const touchActivation = React.useRef(false);
    const hintTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (hintTimeout.current !== null) clearTimeout(hintTimeout.current);
    }, []);
    const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        touchActivation.current = event.pointerType === 'touch';
    }, []);
    const finalMessage = segmented ? undefined : getLiveFinalMessage(turn.assistantMessages);
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const isRunning = isWorking && !finalMessage;
    const settled = !isRunning;
    // Keep the trimmed rows while a settled fold closes, so its contents do
    // not jump to the full history under the height animation.
    const preview = React.useMemo(() => !expanded
        ? projectLiveActivityPreview({ ...turn, assistantMessages: activityMessages }, showReasoning) : null,
    [turn, activityMessages, expanded, showReasoning]);
    const commandRows = React.useMemo(() => {
        if (expanded || (isRunning && !preview?.hiddenCount)) return null;
        const messages = getRunningCommandMessages(turn.assistantMessages, isRunning ? new Set(preview?.hiddenRowIds) : undefined);
        if (!messages.length) return null;
        const ids = new Set(messages.flatMap((message) => message.parts.map((part) => part.id)));
        return {
            messages, ids,
            hiddenCount: preview?.hiddenRowIds.filter((id) => !ids.has(id)).length ?? 0,
            previewMessages: preview?.messages.flatMap((message) => {
                const parts = message.parts.filter((part) => !ids.has(part.id));
                return parts.length ? [parts.length === message.parts.length ? message : { ...message, parts }] : [];
            }),
        };
    }, [expanded, isRunning, preview, turn.assistantMessages]);
    const hiddenCount = commandRows?.hiddenCount ?? preview?.hiddenCount ?? 0;
    const rowsRef = React.useRef<HTMLDivElement>(null);
    useActivityRowGlide(rowsRef, preview?.hiddenCount ?? 0, isRunning && !expanded);
    const previouslySettled = React.useRef(settled);
    const animateFinalCollapse = settled && !previouslySettled.current;
    React.useLayoutEffect(() => { previouslySettled.current = settled; }, [settled]);
    // A page the agent showed is never folded away: it sits below the fold,
    // above the answer once one arrives, and stays there in a turn that ended
    // without one. The fold no longer holds it, so it moves at most from the
    // bottom of the fold to the top of the answer.
    const pages = React.useMemo(() => segmented ? (page ? [page] : []) : getShownPages(turn.assistantMessages), [turn.assistantMessages, segmented, page]);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const finalContext = React.useMemo(() => finalMessage ? {
        messageId: finalMessage.info.id, expanded, contentId: finalContentId, animateCollapse: animateFinalCollapse, pages,
    } : null, [finalMessage, expanded, finalContentId, animateFinalCollapse, pages]);
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
    const windowStore = React.useContext(TurnMessageWindowContext);
    // A settled turn can resume while expanded. Retain its mounted head, but
    // clear the old tail limit before paint so new messages remain mounted.
    React.useLayoutEffect(() => {
        if (!isRunning || !windowStore) return;
        const range = windowStore.range(turn.turnId);
        if (range && range.hiddenTail > 0) windowStore.setRange(turn.turnId, { ...range, hiddenTail: 0 });
    }, [isRunning, turn.turnId, windowStore]);

    // Running folds mount their live tail; settled folds hold the clicked
    // header and open downward from the first rows.
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
        if (!expanded) {
            if (!isRunning) dispatchRowExpand(event.currentTarget);
            if (windowStore) {
                const isRow = createActivityRowPredicate(turn.explorationGroups, hoistedPages);
                const rowCount = activityMessages.reduce((total, message) => total + activityRowParts(message.parts, showReasoning, isRow).length, 0);
                windowStore.setRange(turn.turnId, isRunning ? initialMessageWindow(rowCount) : openedFoldMessageWindow(rowCount));
            }
        }
        onToggle();
    }, [activityMessages, expanded, isRunning, onToggle, showReasoning, turn.turnId, turn.explorationGroups, hoistedPages, windowStore]);
    const headerClass = 'group/tool w-full justify-start normal-case !ps-px !pe-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <LiveTurnHoistedPagesContext.Provider value={hoistedPages}>
            <div className="relative z-0" data-live-turn-activity={turn.turnId}>
                <div className="chat-message-column @container">
                    <div className="mt-1">
                        <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle} onPointerDown={handlePointerDown}
                            aria-expanded={expanded} aria-controls={finalMessage ? `${contentId} ${finalContentId}` : contentId}>
                            {label}
                        </Button>
                    </div>
                </div>
                {isRunning && hiddenCount > 0 ? (
                    <div className="chat-message-column">
                        <Button variant="ghost" size="xs" onClick={handleToggle} onPointerDown={handlePointerDown} aria-expanded={false} aria-controls={contentId}
                            data-live-activity-more="true"
                            className="typography-meta font-normal normal-case text-muted-foreground/45 hover:text-muted-foreground/65 hover:bg-transparent">
                            {t('chat.liveActivity.more', { count: hiddenCount })}
                        </Button>
                    </div>
                ) : null}
                {commandRows && commandRows.messages.length > 0 ? (
                    <div data-live-activity-running-commands="true">
                        {commandRows.messages.map(renderMessage)}
                    </div>
                ) : null}
                <LiveTurnHoistedCommandsContext.Provider value={commandRows?.ids ?? null}>
                    <LiveActivityCollapse expanded={isRunning || expanded} id={contentId}>
                        <div ref={rowsRef}>
                            <TurnMessageWindow turnId={turn.turnId} windowed={preview === null} explorationGroups={turn.explorationGroups}
                                messages={commandRows?.previewMessages ?? preview?.messages ?? activityMessages} renderMessage={renderMessage} />
                        </div>
                    </LiveActivityCollapse>
                    {isRunning && preview?.pinnedText ? (
                        <div className="chat-message-column" data-pinned-activity-text={preview.pinnedText.part.id}>
                            <div aria-hidden="true" className="mt-1.5 mb-3 h-px w-full bg-border" />
                            <AssistantTextPart part={preview.pinnedText.part} messageId={preview.pinnedText.message.info.id}
                                streamPhase={streamingMessageId === preview.pinnedText.message.info.id ? streamPhase : 'completed'} />
                        </div>
                    ) : null}
                    {!finalMessage && pages.length > 0 ? (
                        <div className="chat-message-column">
                            {pages.map((part) => <ShownToolCard key={part.id} part={part} />)}
                        </div>
                    ) : null}
                    <LiveFinalActivityContext.Provider value={finalContext}>
                        {finalMessage ? renderMessage(finalMessage) : null}
                    </LiveFinalActivityContext.Provider>
                </LiveTurnHoistedCommandsContext.Provider>
            </div>
        </LiveTurnHoistedPagesContext.Provider>
    );
}
