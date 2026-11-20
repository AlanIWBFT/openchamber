import React from 'react';

import TurnItem from '../components/TurnItem';
import { SegmentContext } from '../components/toolSegmentContext';
import { toolSegments } from '../lib/turns/toolSegments';
import { useUIStore } from '@/stores/useUIStore';
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
    const reasoning = useUIStore(state => state.showReasoningTraces);
    const defaultExpanded = useUIStore(state => state.activityRenderMode === 'summary');
    const segments = React.useMemo(() => {
        const index = toolSegments(turn, reasoning);
        return {
            index, preview: row.ownsToolPreview ? index.segments.at(-1) : undefined,
            expanded: (id: string) => turnExpansion.get(id) ?? defaultExpanded,
            toggle: onToggleTurnActivity,
        };
    }, [turn, reasoning, turnExpansion, defaultExpanded, row.ownsToolPreview, onToggleTurnActivity]);

    if (row.kind === 'turn-head') {
        return <SegmentContext.Provider value={segments}><TurnItem turn={turn} gapBelow={row.gapBelow} renderMessage={renderMessage} /></SegmentContext.Provider>;
    }

    if (row.kind !== 'turn-message') return null;
    const message = turn.assistantMessages.find(candidate => candidate.info.id === row.messageId);
    return (
        <div className={cn('relative w-full', row.gapBelow && 'pb-2')} data-turn-row={turn.turnId}>
            <SegmentContext.Provider value={segments}><MessageSliceContext.Provider value={row.slice}>
                {message ? renderMessage(message) : null}
            </MessageSliceContext.Provider></SegmentContext.Provider>
        </div>
    );
});

TurnRow.displayName = 'TurnRow';
