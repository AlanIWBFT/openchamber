import React from 'react';
import { toolSegments } from '../lib/turns/toolSegments';

import type { RenderEntry, RenderRow } from './types';

export const useTimelineRowIndexes = (rows: RenderRow[], allEntries: RenderEntry[], showReasoningTraces: boolean) => {
    return React.useMemo(() => {
        const messageIndexes = new Map<string, number>();
        const turnIndexes = new Map<string, number>();
        const rowIndexes = new Map<string, number>();
        const foldedAnchors = new Map<string, { segmentId: string; source: string; part: string }>();
        const collapsible = new Map<string, string[]>();
        const all = new Map<string, string[]>();
        rows.forEach((row, index) => {
            rowIndexes.set(row.key, index);
            if (row.kind === 'ungrouped') {
                messageIndexes.set(row.entry.message.info.id, index);
                return;
            }
            const { turnId } = row.entry.turn;
            if (row.kind === 'turn-head') {
                turnIndexes.set(turnId, index);
                messageIndexes.set(row.entry.turn.userMessage.info.id, index);
            } else if (row.kind === 'turn-message') {
                if (!row.slice?.from) messageIndexes.set(row.messageId, index);
                if (row.slice?.from) rowIndexes.set(`step:${row.messageId}:${row.slice.from.partId}:${row.slice.from.offset}`, index);
            }
        });
        for (const entry of allEntries) {
            if (entry.kind !== 'turn') continue;
            const { turnId, assistantMessages } = entry.turn;
            const segments = toolSegments(entry.turn, showReasoningTraces);
            for (const [message, ids] of segments.byMessage) collapsible.set(message, [...ids]);
            const fallback = turnIndexes.get(turnId);
            assistantMessages.forEach((message) => {
                const messageId = message.info.id;
                const rowIndex = messageIndexes.get(messageId);
                const row = rowIndex !== undefined ? rows[rowIndex] : undefined;
                if (!row || (row.kind === 'turn-message' && row.foldedHeader)) {
                    if (!row && fallback !== undefined) messageIndexes.set(messageId, fallback);
                    const first = message.parts.find(part => segments.byPart.has(part.id));
                    const segment = first && segments.byPart.get(first.id)?.segment;
                    if (segment) foldedAnchors.set(messageId, { segmentId: segment.id, source: segment.rows[0].messageID, part: segment.rows[0].id });
                }
                all.set(messageId, collapsible.get(messageId) ?? []);
            });
        }
        return {
            messageIndexMap: messageIndexes,
            turnIndexMap: turnIndexes,
            rowIndexByKey: rowIndexes,
            foldedAnchorByMessage: foldedAnchors,
            collapsibleTurnByMessageId: collapsible,
            turnByAssistantMessageId: all,
        };
    }, [allEntries, rows, showReasoningTraces]);
};
