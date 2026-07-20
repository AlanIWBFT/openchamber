import type { ToolPart } from '@opencode-ai/sdk/v2';

export type UnifiedExecMetadata = {
    command?: string;
    output?: string;
    interactions?: Array<{ type: 'stdin' | 'terminate'; time: number }>;
    sessionID?: number;
    sessionExposed?: boolean;
    startedAt?: number;
    durationMs?: number;
    processRunning?: boolean;
    exitCode?: number;
    outputError?: string;
    truncated?: boolean;
    terminationRequested?: boolean;
    execDisplay?: 'root' | 'poll' | 'stdin' | 'terminate';
    execError?: string;
};

export type UnifiedExecStatus = {
    kind: 'error' | 'running' | 'terminated' | 'exited' | 'completed';
    durationMs?: number;
    exitCode?: number;
    error: boolean;
};

export type WriteStdinOperation = 'preparing' | 'polling' | 'sending';

const FOLLOW_UP_TOOLS = new Set(['write_stdin', 'terminate_exec']);

export const isExecCommandTool = (tool: unknown): boolean => tool === 'exec_command';

export const isUnifiedExecTool = (tool: unknown): boolean => (
    isExecCommandTool(tool) || FOLLOW_UP_TOOLS.has(typeof tool === 'string' ? tool : '')
);

export const isWriteStdinPoll = (input: Record<string, unknown> | undefined): boolean => {
    const hasCharacters = typeof input?.chars === 'string' && input.chars.length > 0;
    return !hasCharacters && input?.close_stdin !== true;
};

export const getWriteStdinOperation = (
    status: unknown,
    input: Record<string, unknown> | undefined,
): WriteStdinOperation | undefined => {
    if (status === 'pending') return 'preparing';
    if (status !== 'running') return undefined;
    return isWriteStdinPoll(input) ? 'polling' : 'sending';
};

const isExecFollowUpTool = (tool: unknown): boolean => (
    FOLLOW_UP_TOOLS.has(typeof tool === 'string' ? tool : '')
);

export const getUnifiedExecMetadata = (part: ToolPart): UnifiedExecMetadata => {
    const metadata = part.state && 'metadata' in part.state ? part.state.metadata : undefined;
    return metadata && typeof metadata === 'object' ? metadata as UnifiedExecMetadata : {};
};

export const shouldHideExecFollowUp = (part: ToolPart): boolean => {
    return shouldHideExecFollowUpState(part.tool, part.state?.status, getUnifiedExecMetadata(part));
};

export const shouldHideExecFollowUpState = (
    tool: unknown,
    status: unknown,
    metadata: UnifiedExecMetadata,
): boolean => {
    if (!isExecFollowUpTool(tool)) return false;
    if (status === 'error') return false;
    const error = metadata.execError;
    return typeof error !== 'string' || error.length === 0;
};

export const isExecProcessRunning = (tool: unknown, metadata: UnifiedExecMetadata, stateStatus?: unknown): boolean => (
    isExecCommandTool(tool)
    && stateStatus !== 'error'
    && metadata.processRunning === true
    && !(typeof metadata.execError === 'string' && metadata.execError.length > 0)
);

export const redactExecFollowUpInput = (
    tool: unknown,
    input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
    if (!input || !isExecFollowUpTool(tool)) return input;
    const safeInput = { ...input };
    delete safeInput.chars;
    return safeInput;
};

export const getUnifiedExecCommand = (
    input: Record<string, unknown> | undefined,
    metadata: UnifiedExecMetadata,
    title?: string,
): string => {
    if (typeof metadata.command === 'string') return metadata.command;
    if (typeof input?.cmd === 'string') return input.cmd;
    if (typeof input?.command === 'string') return input.command;
    return title ?? '';
};

export const getUnifiedExecOutput = (metadata: UnifiedExecMetadata, fallback: unknown): string => {
    const output = typeof metadata.output === 'string'
        ? metadata.output
        : typeof fallback === 'string' ? fallback : '';
    return output.replace(/\r\n?/g, '\n');
};

export const formatUnifiedExecDuration = (durationMs: number, locale = 'en'): string => {
    const bounded = Math.max(0, durationMs);
    const formatUnit = (value: number, unit: Intl.NumberFormatOptions['unit'], fractionDigits = 0) => (
        new Intl.NumberFormat(locale, {
            style: 'unit',
            unit,
            unitDisplay: 'narrow',
            minimumFractionDigits: fractionDigits,
            maximumFractionDigits: fractionDigits,
        }).format(value)
    );
    if (bounded < 60_000) return formatUnit(Number(Math.max(0.1, bounded / 1000).toFixed(1)), 'second', 1);

    const totalSeconds = Math.floor(bounded / 1000);
    const days = Math.floor(totalSeconds / 86_400);
    const hours = Math.floor((totalSeconds % 86_400) / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${formatUnit(days, 'day')} ${formatUnit(hours, 'hour')}`;
    if (hours > 0) return `${formatUnit(hours, 'hour')} ${formatUnit(minutes, 'minute')}`;
    return `${formatUnit(minutes, 'minute')} ${formatUnit(seconds, 'second')}`;
};

export const getUnifiedExecStatus = (
    metadata: UnifiedExecMetadata,
    now: number,
    stateStatus?: unknown,
): UnifiedExecStatus | null => {
    if (stateStatus === 'error' || (typeof metadata.execError === 'string' && metadata.execError.length > 0)) {
        return { kind: 'error', error: true };
    }
    if (metadata.execDisplay !== 'root') return null;
    const sessionExposed = metadata.sessionExposed === true;
    const duration = sessionExposed
        ? metadata.processRunning === true && typeof metadata.startedAt === 'number'
            ? now - metadata.startedAt
            : metadata.durationMs
        : undefined;
    const durationField = typeof duration === 'number' ? { durationMs: duration } : {};

    if (metadata.processRunning === true && typeof metadata.sessionID === 'number') {
        if (!sessionExposed) return null;
        return { kind: 'running', ...durationField, error: false };
    }
    if (metadata.terminationRequested === true) return { kind: 'terminated', ...durationField, error: false };
    if (typeof metadata.exitCode === 'number' && metadata.exitCode !== 0) {
        return { kind: 'exited', exitCode: metadata.exitCode, ...durationField, error: true };
    }
    if (sessionExposed && typeof metadata.durationMs === 'number') {
        return { kind: 'completed', ...durationField, error: false };
    }
    return null;
};
