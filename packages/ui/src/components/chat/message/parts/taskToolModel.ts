import type { MessageRecord } from '@/lib/messageCompletion';

import { readTaskTagSessionIdFromOutput } from './taskSessionIdParser';
import { redactExecFollowUpInput, shouldHideExecFollowUp, shouldHideExecFollowUpState } from '../unifiedExec';

export type TaskToolSummaryEntry = {
    id?: string;
    tool?: string;
    state?: {
        status?: string;
        title?: string;
        input?: Record<string, unknown>;
        error?: string;
    };
};

const normalizeSessionIdCandidate = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

export const readTaskSessionIdFromRecord = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return normalizeSessionIdCandidate(record.sessionID) ?? normalizeSessionIdCandidate(record.sessionId);
};

export const normalizeTaskSummaryEntries = (value: unknown): TaskToolSummaryEntry[] => {
    if (!Array.isArray(value)) return [];

    const normalized: TaskToolSummaryEntry[] = [];
    for (const entry of value) {
        if (typeof entry === 'string') {
            normalized.push({ tool: 'tool', state: { status: 'completed', title: entry } });
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        const record = entry as {
            id?: unknown;
            tool?: unknown;
            title?: unknown;
            status?: unknown;
            metadata?: unknown;
            state?: { status?: unknown; title?: unknown; input?: unknown; metadata?: unknown; error?: unknown };
        };
        const tool = typeof record.tool === 'string' ? record.tool : 'tool';
        const status = typeof record.state?.status === 'string'
            ? record.state.status
            : typeof record.status === 'string' ? record.status : undefined;
        const metadataCandidate = record.state?.metadata ?? record.metadata;
        const metadata = metadataCandidate && typeof metadataCandidate === 'object'
            ? metadataCandidate as Record<string, unknown>
            : {};
        if (shouldHideExecFollowUpState(tool, status, metadata)) continue;
        const error = typeof record.state?.error === 'string' && record.state.error.length > 0
            ? record.state.error
            : typeof metadata.execError === 'string' && metadata.execError.length > 0
                ? metadata.execError
                : undefined;
        normalized.push({
            id: typeof record.id === 'string' ? record.id : undefined,
            tool,
            state: {
                status: error ? 'error' : status,
                title: typeof record.state?.title === 'string'
                    ? record.state.title
                    : typeof record.title === 'string' ? record.title : undefined,
                input: redactExecFollowUpInput(
                    tool,
                    record.state?.input && typeof record.state.input === 'object'
                        ? record.state.input as Record<string, unknown>
                        : undefined,
                ),
                ...(error ? { error } : {}),
            },
        });
    }
    return normalized;
};

export const parseTaskMetadataBlock = (output: string | undefined): {
    sessionId?: string;
    summaryEntries: TaskToolSummaryEntry[];
} => {
    if (typeof output !== 'string' || output.trim().length === 0) return { summaryEntries: [] };
    const blockMatch = output.match(/<task_metadata>\s*([\s\S]*?)\s*<\/task_metadata>/i);
    if (!blockMatch?.[1]) return { summaryEntries: [] };

    try {
        const parsed = JSON.parse(blockMatch[1].trim()) as Record<string, unknown>;
        return {
            sessionId: normalizeSessionIdCandidate(parsed.sessionId) ?? normalizeSessionIdCandidate(parsed.sessionID),
            summaryEntries: normalizeTaskSummaryEntries(parsed.summary ?? parsed.entries ?? parsed.tools ?? parsed.calls),
        };
    } catch {
        return { summaryEntries: [] };
    }
};

export const readTaskSessionIdFromOutput = (output: string | undefined): string | undefined => {
    if (typeof output !== 'string' || output.trim().length === 0) return undefined;
    const parsedMetadata = parseTaskMetadataBlock(output);
    if (parsedMetadata.sessionId) return parsedMetadata.sessionId;

    const taskMatch = output.match(/task_id\s*:\s*([^\s<"']+)/i);
    const sessionMatch = output.match(/session[_\s-]?id\s*:\s*([^\s<"']+)/i);
    const candidate = taskMatch?.[1] ?? sessionMatch?.[1];
    if (candidate) return normalizeSessionIdCandidate(candidate);
    return normalizeSessionIdCandidate(readTaskTagSessionIdFromOutput(output));
};

const messageSummaryCache = new WeakMap<MessageRecord, TaskToolSummaryEntry[]>();

const projectMessageSummaryEntries = (message: MessageRecord): TaskToolSummaryEntry[] => {
    const cached = messageSummaryCache.get(message);
    if (cached) return cached;

    const entries: TaskToolSummaryEntry[] = [];
    if (message.info.role === 'assistant') {
        for (const part of message.parts) {
            if (part.type !== 'tool') continue;
            if (shouldHideExecFollowUp(part)) continue;
            const toolName = part.tool?.trim().toLowerCase();
            if (!toolName || toolName === 'task' || toolName === 'todowrite' || toolName === 'todoread') continue;
            const state = part.state as { status?: string; title?: string; input?: unknown; metadata?: unknown; error?: unknown } | undefined;
            const metadata = state?.metadata && typeof state.metadata === 'object'
                ? state.metadata as Record<string, unknown>
                : {};
            const error = typeof state?.error === 'string' && state.error.length > 0
                ? state.error
                : typeof metadata.execError === 'string' && metadata.execError.length > 0
                    ? metadata.execError
                    : undefined;
            entries.push({
                id: part.id,
                tool: part.tool,
                state: {
                    status: error ? 'error' : state?.status,
                    title: state?.title,
                    input: redactExecFollowUpInput(
                        part.tool,
                        state?.input && typeof state.input === 'object'
                            ? state.input as Record<string, unknown>
                            : undefined,
                    ),
                    ...(error ? { error } : {}),
                },
            });
        }
    }
    messageSummaryCache.set(message, entries);
    return entries;
};

export const buildTaskSummaryEntriesFromSession = (messages: MessageRecord[]): TaskToolSummaryEntry[] => {
    const entries: TaskToolSummaryEntry[] = [];
    for (const message of messages) entries.push(...projectMessageSummaryEntries(message));
    return entries;
};

export const stripTaskMetadataFromOutput = (output: string): string => {
    return output.replace(/\n*<task_metadata>[\s\S]*?<\/task_metadata>\s*$/i, '').trimEnd();
};
