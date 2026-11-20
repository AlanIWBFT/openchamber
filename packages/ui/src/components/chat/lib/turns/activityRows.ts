import type { Part, ToolPart } from '@/lib/opencode/model';
import { filterVisibleParts, isEmptyTextPart } from '../../message/partUtils';
import { readUnifiedExecMetadata, shouldHideExecFollowUpState } from '@/lib/opencode/tools';

const isToolRunning = (status: string | undefined): boolean => (
    status === 'pending' || status === 'running' || status === 'started'
);

export const isToolRowShown = (toolPart: ToolPart): boolean => {
    const { state } = toolPart;
    if (isToolRunning(state.status)) return true;
    if (state.status !== 'completed' && state.status !== 'error') return false;
    return state.time.end >= state.time.start;
};

const isActivityRowPart = (part: Part): boolean => {
    if (part.type === 'tool') return isToolRowShown(part)
        && !shouldHideExecFollowUpState(part.tool, part.state.status, readUnifiedExecMetadata(part.state.status === 'pending' ? undefined : part.state.metadata));
    if (part.type === 'text') return !isEmptyTextPart(part);
    return part.type === 'reasoning';
};

export const activityRowParts = (parts: Part[], showReasoning: boolean, isRow = isActivityRowPart): Part[] => (
    filterVisibleParts(parts, { includeReasoning: showReasoning }).filter(isRow)
);
