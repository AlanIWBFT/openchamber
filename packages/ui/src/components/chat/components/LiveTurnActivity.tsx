import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { ChatMessageEntry, TurnRecord } from '../lib/turns/types';
import { getLiveFinalMessage, projectLiveActivityPreview } from '../lib/turns/liveActivity';
import { summarizeLiveActivity } from '../lib/turns/liveActivitySummary';
import AssistantTextPart from '../message/parts/AssistantTextPart';
import type { StreamPhase } from '../message/types';
import { cn } from '@/lib/utils';
import { TurnMessageWindow } from './TurnMessageWindow';
import { TurnMessageWindowContext, initialMessageWindow, isReaderAtTimelineEnd, openedFoldMessageWindow } from '../lib/turns/turnMessageWindow';

interface LiveTurnActivityProps {
    turn: TurnRecord;
    expanded: boolean;
    isWorking: boolean;
    streamingMessageId?: string | null;
    streamPhase: StreamPhase;
    showReasoning: boolean;
    onToggle: () => void;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

export function LiveTurnActivity({ turn, expanded, isWorking, streamingMessageId, streamPhase, showReasoning, onToggle, renderMessage }: LiveTurnActivityProps) {
    const { t } = useI18n();
    const contentId = React.useId();
    const [showTouchHint, setShowTouchHint] = React.useState(false);
    const touchActivation = React.useRef(false);
    const hintTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => {
        if (hintTimeout.current !== null) clearTimeout(hintTimeout.current);
    }, []);
    const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
        touchActivation.current = event.pointerType === 'touch';
    }, []);
    const finalMessage = getLiveFinalMessage(turn.assistantMessages);
    const activityMessages = React.useMemo(
        () => (finalMessage ? turn.assistantMessages.filter((message) => message !== finalMessage) : turn.assistantMessages),
        [finalMessage, turn.assistantMessages],
    );
    const isRunning = isWorking && !finalMessage;
    const settled = !isRunning;
    const preview = React.useMemo(() => !expanded && isRunning ? projectLiveActivityPreview(turn, showReasoning) : null,
        [turn, expanded, isRunning, showReasoning]);
    const answer = React.useMemo(() => {
        if (!finalMessage || expanded) return finalMessage;
        const parts = finalMessage.parts.filter((part) => part.type === 'text');
        return parts.length === finalMessage.parts.length ? finalMessage : { ...finalMessage, parts };
    }, [finalMessage, expanded]);
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
                    className={cn('grid min-w-0 flex-1 text-left typography-meta text-[var(--tools-description)] transition-opacity group-hover/tool:opacity-100 motion-reduce:transition-none',
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
            {details ? <span className="hidden min-w-0 flex-1 truncate text-left typography-meta @min-[560px]:inline" title={details}>{fileLabel ? '· ' : ''}{details}</span> : null}
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

    // Running folds always mount their live tail. Settled folds choose the
    // end that stays on screen for the reader (see openedFoldMessageWindow).
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
        if (!expanded && windowStore) {
            const range = isRunning
                ? initialMessageWindow(activityMessages.length)
                : openedFoldMessageWindow(activityMessages.length, isReaderAtTimelineEnd(event.currentTarget));
            windowStore.setRange(turn.turnId, range);
        }
        onToggle();
    }, [activityMessages.length, expanded, isRunning, onToggle, turn.turnId, windowStore]);
    const headerClass = 'group/tool w-full justify-start normal-case !pl-px !pr-2 text-[var(--tools-description)] hover:!bg-transparent active:!bg-transparent';
    return (
        <div className="relative z-0" data-live-turn-activity={turn.turnId}>
            <div className="chat-message-column @container">
                <div className="mt-1">
                    <Button variant="ghost" size="sm" className={headerClass} onClick={handleToggle} onPointerDown={handlePointerDown}
                        aria-expanded={expanded} aria-controls={contentId}>
                        {label}
                    </Button>
                </div>
            </div>
            {preview && preview.hiddenCount > 0 ? (
                <div className="chat-message-column">
                    <Button variant="ghost" size="xs" onClick={handleToggle} onPointerDown={handlePointerDown} aria-expanded={false} aria-controls={contentId}
                        data-live-activity-more="true"
                        className="typography-meta font-normal normal-case text-muted-foreground/45 hover:text-muted-foreground/65 hover:bg-transparent">
                        {t('chat.liveActivity.more', { count: preview.hiddenCount })}
                    </Button>
                </div>
            ) : null}
            <div id={contentId} data-live-activity-content="true">
                {expanded ? (
                    <TurnMessageWindow turnId={turn.turnId} messages={activityMessages} renderMessage={renderMessage} />
                ) : preview?.messages.map(renderMessage)}
            </div>
            {preview?.pinnedText ? (
                <div className="chat-message-column" data-pinned-activity-text={preview.pinnedText.part.id}>
                    <div aria-hidden="true" className="mt-1.5 mb-3 h-px w-full bg-border" />
                    <AssistantTextPart part={preview.pinnedText.part} messageId={preview.pinnedText.message.info.id}
                        streamPhase={streamingMessageId === preview.pinnedText.message.info.id ? streamPhase : 'completed'} chatRenderMode="live" />
                </div>
            ) : null}
            {answer ? renderMessage(answer) : null}
        </div>
    );
}
