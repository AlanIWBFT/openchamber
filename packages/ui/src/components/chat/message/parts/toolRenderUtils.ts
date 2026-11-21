import { isNavigationTool, normalizeToolName, type ToolName } from '@/lib/opencode/tools';
import { isExplorationGroupTool as isExplorationTool } from '@/lib/opencode/exploration';
export { getReadToolDisplayType, isExplorationGroupTool as isExplorationTool, isExplorationPartDisplayReady } from '@/lib/opencode/exploration';

export const formatDirectoryDisplayPath = (path: string): string => {
    return path && !path.includes('/') ? `${path}/` : path;
};

export const isExpandableTool = (toolName: ToolName): boolean => {
    return !isStaticTool(toolName);
};

export const isStaticTool = (toolName: ToolName): boolean => isNavigationTool(toolName);
export const countExplorationTools = (toolNames: ToolName[]) => {
    return toolNames.reduce<{ search: number; read: number }>((result, toolName) => {
        if (!isExplorationTool(toolName)) return result;
        if (normalizeToolName(toolName) === 'read') result.read += 1;
        else result.search += 1;
        return result;
    }, { search: 0, read: 0 });
};
