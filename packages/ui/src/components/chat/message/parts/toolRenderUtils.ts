// Keep only tools with a purpose-built compact interaction here. Skill opens
// its file; every other tool uses ToolPart so built-in, custom, plugin, and MCP
// calls expose their input and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>(['skill']);

const STANDALONE_TOOL_NAMES = new Set<string>(['task']);

const EXPLORATION_TOOL_NAMES = new Set<string>(['read', 'glob', 'grep', 'list']);

const HIDDEN_SESSION_TOOL_NAMES = new Set<string>(['todowrite']);

const TERMINAL_TOOL_STATUSES = new Set<unknown>(['error', 'aborted', 'failed', 'timeout', 'cancelled']);

export const getReadToolDisplayType = (metadata: unknown, output: unknown): 'file' | 'directory' | 'unknown' => {
    if (metadata && typeof metadata === 'object') {
        const display = (metadata as { display?: unknown }).display;
        if (display && typeof display === 'object') {
            const type = (display as { type?: unknown }).type;
            if (type === 'file' || type === 'directory') return type;
        }
    }

    if (typeof output === 'string') {
        const type = output.match(/<type>(file|directory)<\/type>/i)?.[1]?.toLowerCase();
        if (type === 'file' || type === 'directory') return type;
    }

    return 'unknown';
};

export const formatDirectoryDisplayPath = (path: string): string => {
    return path && !path.includes('/') ? `${path}/` : path;
};

export const normalizeToolName = (toolName: unknown): string => {
    if (typeof toolName !== 'string') return '';
    const trimmed = toolName.trim().toLowerCase();
    if (!trimmed) return '';

    const withoutIndex = trimmed.replace(/:\d+$/, '');
    if (withoutIndex.includes('.')) {
        const parts = withoutIndex.split('.').filter(Boolean);
        return parts[parts.length - 1] ?? withoutIndex;
    }
    return withoutIndex;
};

export const isExpandableTool = (toolName: unknown): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: unknown): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const isHiddenSessionTool = (toolName: unknown, status?: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return HIDDEN_SESSION_TOOL_NAMES.has(toolName.trim().toLowerCase().replace(/:\d+$/, ''))
        && !TERMINAL_TOOL_STATUSES.has(status);
};

export const isExplorationTool = (toolName: unknown): boolean => {
    if (typeof toolName !== 'string') return false;
    return EXPLORATION_TOOL_NAMES.has(toolName.trim().toLowerCase().replace(/:\d+$/, ''));
};

export const countExplorationTools = (toolNames: unknown[]): { search: number; read: number } => {
    return toolNames.reduce<{ search: number; read: number }>((result, toolName) => {
        if (!isExplorationTool(toolName)) return result;
        if (normalizeToolName(toolName) === 'read') result.read += 1;
        else result.search += 1;
        return result;
    }, { search: 0, read: 0 });
};

export const isExplorationPartDisplayReady = (part: unknown): boolean => {
    const state = (part as { state?: { status?: unknown; time?: { start?: unknown; end?: unknown } } } | null)?.state;
    if (state?.status === 'pending' || state?.status === 'running' || state?.status === 'started') return true;
    if (TERMINAL_TOOL_STATUSES.has(state?.status)) return true;
    const end = state?.time?.end;
    if (typeof end !== 'number') return false;
    const start = state?.time?.start;
    return typeof start !== 'number' || end >= start;
};

export const isStaticTool = (toolName: unknown): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const getToolDescriptionFallback = (
    toolName: unknown,
    description: unknown,
    input: Record<string, unknown> | undefined,
): string => {
    if (typeof description === 'string' && description.trim().length > 0) {
        return description;
    }

    const globPattern = normalizeToolName(toolName) === 'glob' ? input?.pattern : undefined;
    return typeof globPattern === 'string' ? globPattern : '';
};
