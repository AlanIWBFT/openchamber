import { createContext } from 'react';
import type { Part, ToolPart } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { isExplorationPartDisplayReady, readUnifiedExecMetadata, shouldHideExecFollowUpState } from '@/lib/opencode/tools';
import type { TurnExplorationGroup } from './types';

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
    if (part.type === 'tool') return isToolRowShown(part)
        && !shouldHideExecFollowUpState(part.tool, part.state.status, readUnifiedExecMetadata(part.state.status === 'pending' ? undefined : part.state.metadata));
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

/** An Exploration group draws once at its anchor, even across message boundaries. */
export const createActivityRowPredicate = (groups: readonly TurnExplorationGroup[], excluded?: ReadonlySet<string> | null) => {
    const grouped = new Set<string>();
    const anchors = new Set<string>();
    for (const group of groups) {
        for (const activity of group.parts) grouped.add(activity.id);
        if (group.parts[0] && group.parts.some((activity) => isExplorationPartDisplayReady(activity.part))) anchors.add(group.parts[0].id);
    }
    return (part: Part): boolean => !excluded?.has(part.id) && (grouped.has(part.id) ? anchors.has(part.id) : isActivityRowPart(part));
};

export const activityRowParts = (parts: Part[], showReasoning: boolean, isRow = isActivityRowPart): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter(isRow)
);

/** The message the row window cuts into, and how many first rows it hides. */
export const ActivityRowSkipContext = createContext<{ messageId: string; rows: number; partIds?: ReadonlySet<string> } | null>(null);
