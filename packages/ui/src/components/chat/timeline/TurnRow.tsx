import React from 'react';

import TurnItem from '../components/TurnItem';
import { TurnFold, TurnPagesRow } from '../components/LiveTurnActivity';
import { useTurnFoldContexts } from '../components/useTurnFold';
import { LiveFinalActivityContext, LiveTurnHoistedCommandsContext, LiveTurnHoistedPagesContext } from '../components/liveActivityContext';
import { getRunningCommandMessages, projectFoldMessages, splitLiveActivityAtPages } from '../lib/turns/liveActivity';
import { MessageSliceContext } from '../message/messageSliceContext';
import { cn } from '@/lib/utils';
import type { RenderRow, ToggleTurnActivity, TurnEntry } from './types';
import { useTurnMessageRenderer, type TurnRendererInput } from './useTurnMessageRenderer';

type TurnRowProps = Omit<TurnRendererInput, 'turn' | 'isLastTurn' | 'nextEntryFirstMessage'> & {
    row: Exclude<RenderRow, { kind: 'ungrouped' }>;
    entry: TurnEntry;
    turnExpansion: Map<string, boolean>;
    onToggleTurnActivity: ToggleTurnActivity;
};

export const TurnRow = React.memo(({
    row,
    entry,
    turnExpansion,
    onToggleTurnActivity,
    ...rendererInput
}: TurnRowProps) => {
    const { turn } = entry;
    const renderMessage = useTurnMessageRenderer({
        ...rendererInput,
        turn,
        isLastTurn: entry.isLastTurn,
        nextEntryFirstMessage: entry.nextEntryFirstMessage,
    });
    const isActivityExpanded = turnExpansion.get(row.foldId) ?? row.expanded;
    const segment = React.useMemo(() => row.segmentId ? splitLiveActivityAtPages(turn).find((item) => item.id === row.segmentId) : undefined, [turn, row.segmentId]);
    const foldTurn = React.useMemo(() => segment ? { ...turn, turnId: segment.id, assistantMessages: segment.messages } : turn, [turn, segment]);
    const projected = React.useMemo(() => projectFoldMessages(foldTurn, row.finalMessageId), [foldTurn, row.finalMessageId]);
    const hoistedCommands = React.useMemo(() => !isActivityExpanded && row.finalMessageId
        ? new Set(getRunningCommandMessages(turn.assistantMessages).flatMap((message) => message.parts.map((part) => part.id))) : null,
    [isActivityExpanded, row.finalMessageId, turn.assistantMessages]);
    const hasLaterAssistant = entry.hasLaterAssistant === true;
    const foldContexts = useTurnFoldContexts(turn, hasLaterAssistant, isActivityExpanded, row.finalMessageId);
    const handleToggleActivity = React.useCallback(() => {
        onToggleTurnActivity(row.foldId);
    }, [onToggleTurnActivity, row.foldId]);

    if (row.kind === 'turn-head') {
        return <TurnItem turn={turn} gapBelow={row.gapBelow} renderMessage={renderMessage} />;
    }

    let content: React.ReactNode = null;
    if (row.kind === 'turn-fold') {
        content = (
            <TurnFold turn={foldTurn} hasLaterAssistant={hasLaterAssistant} expanded={isActivityExpanded}
                isWorking={rendererInput.sessionIsWorking && entry.isLastTurn}
                streamingMessageId={rendererInput.activeStreamingMessageId} streamPhase={rendererInput.activeStreamingPhase}
                finalMessageId={row.finalMessageId} onToggle={handleToggleActivity} renderMessage={renderMessage} />
        );
    } else if (row.kind === 'turn-pages') {
        content = <TurnPagesRow turn={turn} pageId={row.pageId} />;
    } else {
        const message = row.final ? projected.finalMessage : projected.activityMessages.find((candidate) => candidate.info.id === row.messageId);
        if (message) {
            content = (
                <MessageSliceContext.Provider value={row.slice}>
                    {row.final ? (
                        <LiveFinalActivityContext.Provider value={foldContexts.finalContext}>
                            <LiveTurnHoistedCommandsContext.Provider value={hoistedCommands}>{renderMessage(message)}</LiveTurnHoistedCommandsContext.Provider>
                        </LiveFinalActivityContext.Provider>
                    ) : renderMessage(message)}
                </MessageSliceContext.Provider>
            );
        }
    }

    const underFold = row.underFold;
    return (
        <div className={cn('relative w-full', row.gapBelow && 'pb-2')} data-turn-row={turn.turnId}>
            {underFold ? (
                <LiveTurnHoistedPagesContext.Provider value={foldContexts.hoistedPages}>{content}</LiveTurnHoistedPagesContext.Provider>
            ) : content}
        </div>
    );
});

TurnRow.displayName = 'TurnRow';
