import React from 'react';
import { projectFoldMessages, splitLiveActivityAtPages } from '../lib/turns/liveActivity';

import type { RenderEntry, RenderRow } from './types';

export const useTimelineRowIndexes = (rows: RenderRow[], allEntries: RenderEntry[]) => {
    return React.useMemo(() => {
        const messageIndexes = new Map<string, number>();
        const turnIndexes = new Map<string, number>();
        const rowIndexes = new Map<string, number>();
        const collapsible = new Map<string, string[]>();
        const all = new Map<string, string[]>();
        const foldIndexes = new Map<string, number>();
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
            } else if (row.kind === 'turn-fold') {
                if (!foldIndexes.has(turnId)) foldIndexes.set(turnId, index);
                const segment = row.segmentId && splitLiveActivityAtPages(row.entry.turn).find((item) => item.id === row.segmentId);
                const messages = segment ? segment.messages : projectFoldMessages(row.entry.turn, row.finalMessageId).activityMessages;
                for (const message of messages) {
                    collapsible.set(message.info.id, [...(collapsible.get(message.info.id) ?? []), row.foldId]);
                    if (!messageIndexes.has(message.info.id)) messageIndexes.set(message.info.id, index);
                }
            } else if (row.kind === 'turn-message') {
                if (!row.slice?.from && (row.final || !messageIndexes.has(row.messageId) || rows[messageIndexes.get(row.messageId)!]?.kind === 'turn-fold')) messageIndexes.set(row.messageId, index);
                if (row.slice?.from) rowIndexes.set(`step:${row.messageId}:${row.slice.from.partId}:${row.slice.from.offset}`, index);
            }
        });
        for (const entry of allEntries) {
            if (entry.kind !== 'turn') continue;
            const { turnId, assistantMessages } = entry.turn;
            const fallback = foldIndexes.get(turnId) ?? turnIndexes.get(turnId);
            assistantMessages.forEach((message) => {
                const messageId = message.info.id;
                if (!messageIndexes.has(messageId) && fallback !== undefined) messageIndexes.set(messageId, fallback);
                all.set(messageId, collapsible.get(messageId) ?? [turnId]);
            });
        }
        return {
            messageIndexMap: messageIndexes,
            turnIndexMap: turnIndexes,
            rowIndexByKey: rowIndexes,
            collapsibleTurnByMessageId: collapsible,
            turnByAssistantMessageId: all,
        };
    }, [allEntries, rows]);
};
