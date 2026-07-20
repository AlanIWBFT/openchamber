import { isNavigationTool, isExplorationGroupTool as isExplorationTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';
export { getReadToolDisplayType, isExplorationGroupTool as isExplorationTool, isExplorationPartDisplayReady } from '@/lib/opencode/tools';

export const formatDirectoryDisplayPath = (path: string): string => {
    return path && !path.includes('/') ? `${path}/` : path;
};

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

// Keep only tools with a direct in-app navigation destination compact. Every
// other tool uses ToolPart so custom, plugin, and MCP calls expose their input
// and output through the common expandable renderer.
export const isStaticTool = (toolName: ToolName): boolean => isNavigationTool(toolName);
export const countExplorationTools = (toolNames: ToolName[]) => {
    return toolNames.reduce<{ search: number; read: number }>((result, toolName) => {
        if (!isExplorationTool(toolName)) return result;
        if (normalizeToolName(toolName) === 'read') result.read += 1;
        else result.search += 1;
        return result;
    }, { search: 0, read: 0 });
};
