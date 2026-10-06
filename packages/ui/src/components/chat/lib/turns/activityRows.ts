import type { ToolPart } from '@/lib/opencode/model';

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
