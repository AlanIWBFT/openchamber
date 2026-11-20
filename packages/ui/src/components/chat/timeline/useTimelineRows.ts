import React from 'react';

import { turnHeaderCanStick } from '../lib/turns/stickyPrompt';
import { toolSegments } from '../lib/turns/toolSegments';
import type { LiveTailStore } from './liveTailStore';
import type { ChatMessageEntry } from '../lib/turns/types';
import { useTurnRecords } from '../hooks/useTurnRecords';
import { buildHistoryEntries, findFirstVisibleMessageId } from '../lib/turns/timelineEntries';
import { buildTimelineRows } from '../lib/turns/timelineRows';
import { streamPerfCount, streamPerfMeasure } from '@/stores/utils/streamDebug';
import { EMPTY_STATIC_ENTRY_MESSAGES, EMPTY_UNGROUPED_MESSAGE_IDS } from './emptyCollections';
import type { RenderEntry, RenderRow } from './types';

export const useTimelineRows = (
    sessionKey: string,
    displayMessages: ChatMessageEntry[],
    options: {
        showTurnChangedFiles: boolean;
        showReasoningTraces: boolean;
        stickyUserHeader: boolean;
        activeStreamingMessageId: string | null;
        liveTail: LiveTailStore;
        defaultActivityExpanded: boolean;
        turnExpansion: Map<string, boolean>;
    },
) => {
    const { showTurnChangedFiles, showReasoningTraces, stickyUserHeader, defaultActivityExpanded, turnExpansion, activeStreamingMessageId, liveTail } = options;
    const { projection, staticTurns, streamingTurn } = useTurnRecords(displayMessages, {
        sessionKey,
        showTurnChangedFiles,
        showReasoningTraces,
    });
    const hasUngroupedStaticEntries = projection.ungroupedMessageIds.size > 0;
    const staticEntryMessages = hasUngroupedStaticEntries ? displayMessages : EMPTY_STATIC_ENTRY_MESSAGES;
    const staticEntryUngroupedIds = hasUngroupedStaticEntries ? projection.ungroupedMessageIds : EMPTY_UNGROUPED_MESSAGE_IDS;
    const trailingStreamingEntry = React.useMemo<RenderEntry | undefined>(() => {
        if (streamingTurn) {
            return {
                kind: 'turn',
                key: `turn:${streamingTurn.turnId}`,
                turn: streamingTurn,
                isLastTurn: streamingTurn.turnId === projection.lastTurnId,
            } satisfies RenderEntry;
        }

        if (projection.ungroupedMessageIds.size === 0) {
            return undefined;
        }

        const lastMessage = displayMessages[displayMessages.length - 1];
        if (!lastMessage || !projection.ungroupedMessageIds.has(lastMessage.info.id)) {
            return undefined;
        }

        return {
            kind: 'ungrouped',
            key: `msg:${lastMessage.info.id}`,
            message: lastMessage,
            nextMessage: undefined,
            isFirstRow: findFirstVisibleMessageId(displayMessages) === lastMessage.info.id,
        } satisfies RenderEntry;
    }, [displayMessages, projection.lastTurnId, projection.ungroupedMessageIds, streamingTurn]);

    if (trailingStreamingEntry) {
        streamPerfCount('ui.message_list.render.streaming');
    }

    const trailingEntryFirstMessage = trailingStreamingEntry
        ? (trailingStreamingEntry.kind === 'turn' ? trailingStreamingEntry.turn.userMessage : trailingStreamingEntry.message)
        : undefined;
    const previousHistoryEntriesRef = React.useRef<RenderEntry[]>([]);
    const hasStreamingTurn = Boolean(streamingTurn);
    const historyEntries = React.useMemo(() => streamPerfMeasure('ui.message_list.render_entries_ms', () => {
        const entries = buildHistoryEntries({
            staticTurns,
            lastTurnId: projection.lastTurnId,
            messages: staticEntryMessages,
            ungroupedMessageIds: staticEntryUngroupedIds,
            hasStreamingTurn,
            trailingEntryFirstMessage,
        }, previousHistoryEntriesRef.current);
        previousHistoryEntriesRef.current = entries;
        return entries;
    }), [hasStreamingTurn, projection.lastTurnId, staticEntryMessages, staticEntryUngroupedIds, staticTurns, trailingEntryFirstMessage]);

    const allEntries = React.useMemo(() => {
        return trailingStreamingEntry ? [...historyEntries, trailingStreamingEntry] : historyEntries;
    }, [historyEntries, trailingStreamingEntry]);

    const liveSourceEntry = React.useMemo(() => activeStreamingMessageId
        ? allEntries.find((entry) => entry.kind === 'turn' ? entry.turn.assistantMessageIds.includes(activeStreamingMessageId) : entry.message.info.id === activeStreamingMessageId) ?? trailingStreamingEntry
        : trailingStreamingEntry, [activeStreamingMessageId, allEntries, trailingStreamingEntry]);
    const liveKey = liveSourceEntry?.key;
    const liveHasSegments = React.useSyncExternalStore(liveTail.subscribe, () => {
        const entry = liveTail.get();
        return entry?.key === liveKey && entry?.kind === 'turn'
            ? toolSegments(entry.turn, showReasoningTraces).segments.length > 0 : undefined;
    });
    const previousRowsRef = React.useRef<RenderRow[]>([]);
    const rows = React.useMemo(() => streamPerfMeasure('ui.message_list.render_rows_ms', () => {
        const next = buildTimelineRows(allEntries, {
            collapsedActivity: !defaultActivityExpanded,
            expandedTurns: turnExpansion,
            liveToolPresence: liveKey && liveHasSegments !== undefined ? { key: liveKey, hasSegments: liveHasSegments } : undefined,
            showReasoningTraces,
        }, previousRowsRef.current);
        previousRowsRef.current = next;
        return next;
    }), [allEntries, defaultActivityExpanded, showReasoningTraces, turnExpansion, liveKey, liveHasSegments]);

    const stickyRowIndices = React.useMemo(() => {
        if (!stickyUserHeader) return undefined;
        const indices: number[] = [];
        rows.forEach((row, index) => {
            if (row.kind === 'turn-head' && turnHeaderCanStick(row.entry.turn.userMessage)) indices.push(index);
        });
        return indices.length > 0 ? indices : undefined;
    }, [rows, stickyUserHeader]);

    return { allEntries, liveSourceEntry, rows, stickyRowIndices };
};
