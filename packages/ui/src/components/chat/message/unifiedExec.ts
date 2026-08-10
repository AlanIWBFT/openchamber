import type { ToolInput, ToolPart } from '@/lib/opencode/model';
import { isExecCommandTool, shouldHideExecFollowUpState, readUnifiedExecInput, readUnifiedExecMetadata, type ToolName, type UnifiedExecMetadata } from '@/lib/opencode/tools';
export { isExecCommandTool, isUnifiedExecTool, redactExecFollowUpInput, shouldHideExecFollowUpState, type UnifiedExecMetadata } from '@/lib/opencode/tools';

type UnifiedExecStatus = {
    kind: 'error' | 'running' | 'terminated' | 'exited' | 'completed';
    durationMs?: number;
    exitCode?: number;
};

export type WriteStdinOperation = 'preparing' | 'sending';

export const getWriteStdinOperation = (
    status: string | undefined,
): WriteStdinOperation | undefined => {
    if (status === 'pending') return 'preparing';
    if (status !== 'running') return undefined;
    return 'sending';
};

export const getUnifiedExecMetadata = (part: ToolPart): UnifiedExecMetadata => {
    const metadata = part.state && 'metadata' in part.state ? part.state.metadata : undefined;
    return readUnifiedExecMetadata(metadata);
};

export const shouldHideExecFollowUp = (part: ToolPart): boolean => {
    return shouldHideExecFollowUpState(part.tool, part.state?.status, getUnifiedExecMetadata(part));
};

export const getExecProcessRunning = (tool: ToolName, metadata: UnifiedExecMetadata, stateStatus?: ToolPart['state']['status']): boolean | undefined => {
    if (!isExecCommandTool(tool)) return undefined;
    if (stateStatus === 'error' || metadata.execError) return false;
    return metadata.processRunning;
};

export const isExecProcessRunning = (tool: ToolName, metadata: UnifiedExecMetadata, stateStatus?: ToolPart['state']['status']): boolean => (
    getExecProcessRunning(tool, metadata, stateStatus) === true
);

export const getUnifiedExecCommand = (
    input: ToolInput | undefined,
    metadata: UnifiedExecMetadata,
    title?: string,
): string => {
    const parsed = readUnifiedExecInput(input);
    return metadata.command ?? parsed.cmd ?? parsed.command ?? title ?? '';
};

export const getUnifiedExecOutput = (metadata: UnifiedExecMetadata, fallback: string): string => {
    const output = metadata.output ?? fallback;
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
    stateStatus?: ToolPart['state']['status'],
): UnifiedExecStatus | null => {
    if (stateStatus === 'error' || metadata.execError) {
        return { kind: 'error' };
    }
    if (metadata.execDisplay !== 'root') return null;
    const sessionExposed = metadata.sessionExposed === true;
    const duration = sessionExposed
        ? metadata.processRunning === true && metadata.startedAt !== undefined
            ? now - metadata.startedAt
            : metadata.durationMs
        : undefined;
    const durationField = duration !== undefined ? { durationMs: duration } : {};

    if (metadata.processRunning === true && (metadata.execID ?? metadata.sessionID) !== undefined) {
        if (!sessionExposed) return null;
        return { kind: 'running', ...durationField };
    }
    if (metadata.terminationRequested === true) return { kind: 'terminated', ...durationField };
    if (metadata.exitCode !== undefined && metadata.exitCode !== 0) {
        return { kind: 'exited', exitCode: metadata.exitCode, ...durationField };
    }
    if (sessionExposed && metadata.durationMs !== undefined) {
        return { kind: 'completed', ...durationField };
    }
    return null;
};
