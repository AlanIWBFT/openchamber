import { createContext } from 'react';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';

export const LIVE_ACTIVITY_VISIBLE_ROWS = 7;

const isToolRunning = (status: string | undefined): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

/** Whether a tool call gets a row: while it runs, and once it ended with sane timing. */
export const isToolRowShown = (toolPart: ToolPart): boolean => {
    const { state } = toolPart;
    if (isToolRunning(state.status)) return true;
    if (state.status !== 'completed' && state.status !== 'error') return false;
    return state.time.end >= state.time.start;
};

/** Whether a visible part draws one row. */
export const isActivityRowPart = (part: Part): boolean => {
    if (part.type === 'tool') return isToolRowShown(part);
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

export const activityRowParts = (parts: Part[], showReasoning: boolean): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter(isActivityRowPart)
);

/** The message the row window cuts into, and how many first rows it hides. */
export const ActivityRowSkipContext = createContext<{ messageId: string; rows: number } | null>(null);
