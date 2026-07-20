import { OPENCODE_TOOLS, isExplorationGroupTool as isExplorationTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';
export { getReadToolDisplayType, isExplorationGroupTool as isExplorationTool, isExplorationPartDisplayReady } from '@/lib/opencode/tools';

// Keep only tools with a purpose-built compact interaction here. Skill opens
// its file; every other tool uses ToolPart so built-in, custom, plugin, and MCP
// calls expose their input and output through the common expandable renderer.
const STATIC_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.skill]);

const STANDALONE_TOOL_NAMES = new Set<string>([OPENCODE_TOOLS.subagent]);


export const formatDirectoryDisplayPath = (path: string): string => {
    return path && !path.includes('/') ? `${path}/` : path;
};

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStandaloneTool = (toolName: ToolName): boolean => {
    return STANDALONE_TOOL_NAMES.has(normalizeToolName(toolName));
};

export const countExplorationTools = (toolNames: ToolName[]) => {
    return toolNames.reduce<{ search: number; read: number }>((result, toolName) => {
        if (!isExplorationTool(toolName)) return result;
        if (normalizeToolName(toolName) === 'read') result.read += 1;
        else result.search += 1;
        return result;
    }, { search: 0, read: 0 });
};

export const isStaticTool = (toolName: ToolName): boolean => {
    return STATIC_TOOL_NAMES.has(normalizeToolName(toolName));
};
