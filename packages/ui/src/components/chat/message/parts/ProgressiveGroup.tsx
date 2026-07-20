import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart, TurnExplorationGroup } from '../../lib/turns/types';
import type { ToolPart as ToolPartType } from '@opencode-ai/sdk/v2';
import type { StreamPhase } from '../types';
import type { ContentChangeReason } from '@/hooks/useChatAutoFollow';
import type { ToolPopupContent } from '../types';
import ToolPart from './ToolPart';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { Text } from '@/components/ui/text';
import { Icon } from "@/components/icon/Icon";
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './toolPresentation';
import { getToolMetadata } from '@/lib/toolHelpers';
import { countExplorationTools, isExpandableTool, isExplorationPartDisplayReady, isExplorationTool, isStandaloneTool, isStaticTool, normalizeToolName } from './toolRenderUtils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { ensureOutsideFileGrantForDesktop } from '@/lib/outsideFileGrants';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { getExternalFaviconUrl } from '@/lib/url';
import { getDirectoryForFilePath, isFilePathWithinDirectory, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';
import { useI18n } from '@/lib/i18n';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-medium', TOOL_ROW_TEXT_CLASS);
const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

interface ProgressiveGroupProps {
    parts: TurnActivityPart[];
    isExpanded: boolean;
    collapsedPreviewCount?: number;
    onToggle: () => void;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
    showHeader: boolean;
    animateRows?: boolean;
    animatedToolIds?: Set<string>;
    explorationGroups?: TurnExplorationGroup[];
    renderJustificationActions?: (activity: TurnActivityPart) => React.ReactNode;
}

const ExternalLinkFavicon: React.FC<{ href: string }> = ({ href }) => {
    const [failed, setFailed] = React.useState(false);
    const faviconUrl = React.useMemo(() => getExternalFaviconUrl(href), [href]);

    if (!faviconUrl || failed) {
        return null;
    }

    return (
        <span className="inline-flex size-[18px] flex-shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)]">
            <img
                src={faviconUrl}
                alt=""
                aria-hidden="true"
                loading="lazy"
                decoding="async"
                className="size-3.5 rounded-sm"
                onError={() => setFailed(true)}
            />
        </span>
    );
};

const isActivityRunning = (activity: TurnActivityPart): boolean => {
    if (activity.kind !== 'tool') return false;
    const part = activity.part as ToolPartType;
    const status = (part.state?.status as string) || undefined;
    const isFinalized = status === 'completed' || status === 'error' || status === 'aborted' || status === 'failed' || status === 'timeout' || status === 'cancelled';
    if (isFinalized) {
        return false;
    }
    if (status === 'running' || status === 'pending' || status === 'started') {
        return true;
    }
    return typeof activity.endedAt !== 'number';
};

/**
 * Parts arrive in correct chronological order:
 * messages in sequence, parts within each message in their natural LLM
 * production order. No re-sorting needed — time-based sorting breaks this
 * because text parts get time.end = message completion time (later than
 * tools), pushing text after tools within the same message.
 */
const sortPartsByTime = (parts: TurnActivityPart[]): TurnActivityPart[] => parts;

/**
 * Extract a short filename from a tool part's input (for aggregation display).
 */
const getToolFileName = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    const filePath =
        (input?.filePath as string) ||
        (input?.file_path as string) ||
        (input?.path as string) ||
        (metadata?.filePath as string) ||
        (metadata?.file_path as string) ||
        (metadata?.path as string);

    if (typeof filePath === 'string' && filePath.trim().length > 0) {
        const lastSlash = filePath.lastIndexOf('/');
        return lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
    }

    return null;
};

const getToolSkillDirectory = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { metadata?: Record<string, unknown> } | undefined;
    const dir = state?.metadata?.dir;

    return typeof dir === 'string' && dir.trim().length > 0 ? dir : null;
};

const toTodoStatusKey = (value: unknown): 'pending' | 'in_progress' | 'completed' | 'cancelled' | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'in_progress' || normalized === 'in progress' || normalized === 'inprogress') return 'in_progress';
    if (normalized === 'completed' || normalized === 'done') return 'completed';
    if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
    return null;
};

const formatTodoSummary = (todos: unknown[]): string | null => {
    if (todos.length === 0) {
        return '0 tasks';
    }

    let pending = 0;
    let inProgress = 0;
    for (const todo of todos) {
        if (!todo || typeof todo !== 'object') {
            continue;
        }
        const status = toTodoStatusKey((todo as { status?: unknown }).status);
        if (!status) {
            continue;
        }
        if (status === 'pending') pending += 1;
        if (status === 'in_progress') inProgress += 1;
    }

    const activeCount = pending + inProgress;
    if (activeCount === 0) {
        return '0 tasks';
    }

    return `${activeCount} ${activeCount === 1 ? 'task' : 'tasks'}`;
};

const getTodoSummaryFromActivity = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: Record<string, unknown>; output?: unknown } | undefined;
    const input = state?.input;
    const output = state?.output;

    if (Array.isArray(input?.todos)) {
        const summary = formatTodoSummary(input.todos);
        if (summary) return summary;
    }

    if (Array.isArray(output)) {
        const summary = formatTodoSummary(output);
        if (summary) return summary;
    }

    if (output && typeof output === 'object' && Array.isArray((output as { todos?: unknown }).todos)) {
        const summary = formatTodoSummary((output as { todos: unknown[] }).todos);
        if (summary) return summary;
    }

    if (typeof output === 'string' && output.trim().length > 0) {
        try {
            const parsed = JSON.parse(output) as unknown;
            if (Array.isArray(parsed)) {
                const summary = formatTodoSummary(parsed);
                if (summary) return summary;
            }
            if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { todos?: unknown }).todos)) {
                const summary = formatTodoSummary((parsed as { todos: unknown[] }).todos);
                if (summary) return summary;
            }
        } catch {
            // Ignore non-JSON output.
        }
    }

    return null;
};

const resolveSkillFilePath = (skillPathOrDir: string): string => {
    const normalizedPath = normalizeFilePath(skillPathOrDir);
    if (!normalizedPath) {
        return '';
    }

    return normalizedPath.toLowerCase().endsWith('/skill.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
};

/**
 * Get a short description for a static tool (for aggregation display).
 */
const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const toolName = part.tool?.toLowerCase() ?? '';
    const state = part.state as { input?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
    const input = state?.input;
    const metadata = state?.metadata;

    // For search tools, show pattern
    if (toolName === 'grep' || toolName === 'search' || toolName === 'find' || toolName === 'ripgrep') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For glob, show pattern
    if (toolName === 'glob') {
        const pattern = input?.pattern;
        if (typeof pattern === 'string' && pattern.trim().length > 0) {
            return pattern.length > 40 ? pattern.slice(0, 40) + '...' : pattern;
        }
    }

    // For web search tools, show query
    if (toolName === 'websearch' || toolName === 'web-search' || toolName === 'search_web' || toolName === 'codesearch' || toolName === 'perplexity') {
        const query = input?.query;
        if (typeof query === 'string' && query.trim().length > 0) {
            return query.length > 50 ? query.slice(0, 50) + '...' : query;
        }
    }

    // For skill, show name
    if (toolName === 'skill') {
        const name = input?.name;
        if (typeof name === 'string' && name.trim().length > 0) {
            return name;
        }
    }

    // For fetch-url tools, show URL
    if (toolName === 'webfetch' || toolName === 'fetch' || toolName === 'curl' || toolName === 'wget') {
        const url =
            (typeof input?.url === 'string' && input.url) ||
            (typeof input?.URL === 'string' && input.URL) ||
            (typeof metadata?.url === 'string' && metadata.url) ||
            (typeof metadata?.URL === 'string' && metadata.URL) ||
            '';

        if (typeof url === 'string' && url.trim().length > 0) {
            return url.trim();
        }
    }

    // For todo tools, show status summary without task names
    if (toolName === 'todowrite' || toolName === 'todoread') {
        return getTodoSummaryFromActivity(activity);
    }

    // Fallback: try filename
    return getToolFileName(activity);
};

type AggregatedRow =
    | { type: 'tool-expandable'; activity: TurnActivityPart }
    | { type: 'tool-static-group'; toolName: string; activities: TurnActivityPart[] }
    | { type: 'exploration'; id: string; activities: TurnActivityPart[] }
    | { type: 'reasoning'; activity: TurnActivityPart }
    | { type: 'justification'; activity: TurnActivityPart }
    | { type: 'tool-fallback'; activity: TurnActivityPart };

interface ExpandableToolRowProps {
    activity: TurnActivityPart;
    isExpanded: boolean;
    isMobile: boolean;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    animateTailText: boolean;
    animateRows: boolean;
}

const ExpandableToolRow: React.FC<ExpandableToolRowProps> = ({
    activity,
    isExpanded,
    isMobile,
    onToggleTool,
    onShowPopup,
    onContentChange,
    animateTailText,
    animateRows,
}) => {
    const handleToggle = React.useCallback(() => {
        onToggleTool(activity.id);
    }, [activity.id, onToggleTool]);

    const content = (
        <ToolPart
            part={activity.part as ToolPartType}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            isMobile={isMobile}
            onContentChange={onContentChange}
            onShowPopup={onShowPopup}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoExpandableToolRow = React.memo(ExpandableToolRow, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.isMobile === next.isMobile
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.onContentChange === next.onContentChange
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && prev.activity.id === next.activity.id
        && prev.activity.kind === next.activity.kind
        && prev.activity.endedAt === next.activity.endedAt
        && areRenderRelevantPartsEqual([prev.activity.part], [next.activity.part]);
});

interface StaticGroupedToolRowProps {
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
    animateRows: boolean;
}

const StaticGroupedToolRow: React.FC<StaticGroupedToolRowProps> = ({
    toolName,
    activities,
    animateTailText,
    animateRows,
}) => {
    const content = (
        <StaticToolRow
            toolName={toolName}
            activities={activities}
            animateTailText={animateTailText}
        />
    );

    const maybeWrapped = animateTailText ? (
        <ToolRevealOnMount animate={true} wipe>
            {content}
        </ToolRevealOnMount>
    ) : content;

    if (!animateRows) {
        return maybeWrapped;
    }

    return <FadeInOnReveal>{maybeWrapped}</FadeInOnReveal>;
};

const MemoStaticGroupedToolRow = React.memo(StaticGroupedToolRow, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && prev.animateRows === next.animateRows
        && areActivityListsEqual(prev.activities, next.activities);
});

/**
 * Aggregate sorted activity parts into display rows.
 * Static tools are rendered as one row per call.
 * Reasoning/justification become inline text.
 * Expandable tools (edit, bash, write, question) stay as individual rows.
 * Unknown tools stay as individual expandable rows (fallback).
 */
const aggregateRows = (parts: TurnActivityPart[], explorationGroupByPartId: Map<string, string>): AggregatedRow[] => {
    const rows: AggregatedRow[] = [];

    let i = 0;
    while (i < parts.length) {
        const activity = parts[i];

        if (activity.kind === 'reasoning') {
            rows.push({ type: 'reasoning', activity });
            i++;
            continue;
        }

        if (activity.kind === 'justification') {
            rows.push({ type: 'justification', activity });
            i++;
            continue;
        }

        // Tool part
        const toolPart = activity.part as ToolPartType;
        const toolName = toolPart.tool?.toLowerCase() ?? '';

        if (isExplorationTool(toolName)) {
            const groupId = explorationGroupByPartId.get(activity.id) ?? `exploration:${activity.id}`;
            const activities = [activity];
            i++;
            while (i < parts.length) {
                const next = parts[i];
                if (
                    next.kind !== 'tool'
                    || !isExplorationTool((next.part as ToolPartType).tool)
                    || (explorationGroupByPartId.get(next.id) ?? groupId) !== groupId
                ) {
                    break;
                }
                activities.push(next);
                i++;
            }
            const visibleActivities = activities.filter((item) => isExplorationPartDisplayReady(item.part));
            if (visibleActivities.length > 0) {
                rows.push({
                    type: 'exploration',
                    id: groupId,
                    activities: visibleActivities,
                });
            }
            continue;
        }

        if (isStandaloneTool(toolName)) {
            // Standalone tools are rendered separately, skip
            i++;
            continue;
        }

        if (isExpandableTool(toolName)) {
            rows.push({ type: 'tool-expandable', activity });
            i++;
            continue;
        }

        if (isStaticTool(toolName)) {
            rows.push({ type: 'tool-static-group', toolName, activities: [activity] });
            i++;
            continue;
        }

        // Unknown/fallback tool — keep as expandable
        rows.push({ type: 'tool-fallback', activity });
        i++;
    }

    return rows;
};

/**
 * Render a static aggregated tool row.
 * Shows: [icon] DisplayName file1.tsx file2.tsx ...
 */
const areActivityListsEqual = (left: TurnActivityPart[], right: TurnActivityPart[]): boolean => {
    if (left === right) {
        return true;
    }

    if (left.length !== right.length) {
        return false;
    }

    for (let index = 0; index < left.length; index += 1) {
        const leftActivity = left[index];
        const rightActivity = right[index];

        if (leftActivity.id !== rightActivity.id) {
            return false;
        }

        if (leftActivity.kind !== rightActivity.kind || leftActivity.endedAt !== rightActivity.endedAt) {
            return false;
        }

        if (!areRenderRelevantPartsEqual([leftActivity.part], [rightActivity.part])) {
            return false;
        }
    }

    return true;
};

const StaticToolRowInner: React.FC<{
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}> = ({ toolName, activities, animateTailText }) => {
    const displayName = getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName);
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
    const skills = useSkillsStore((state) => state.skills);
    const hasRunningActivity = React.useMemo(() => activities.some((activity) => isActivityRunning(activity)), [activities]);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

    const descriptions = React.useMemo(() => {
        const descs: string[] = [];
        for (const activity of activities) {
            const desc = getToolShortDescription(activity);
            if (desc && !descs.includes(desc)) {
                descs.push(desc);
            }
        }
        return descs;
    }, [activities]);

    const skillEntries = React.useMemo(() => {
        if (toolName.toLowerCase() !== 'skill') return [] as Array<{ name: string; path: string }>;

        const entries: Array<{ name: string; path: string }> = [];
        for (const activity of activities) {
            const name = getToolShortDescription(activity);
            if (!name) continue;

            const skill = skillByName.get(name);
            const rawPath = skill?.path || getToolSkillDirectory(activity);
            const path = rawPath ? resolveSkillFilePath(rawPath) : '';
            if (!path || entries.some((entry) => entry.name === name && entry.path === path)) continue;
            entries.push({ name, path });
        }

        return entries;
    }, [activities, skillByName, toolName]);

    const handleFileClick = React.useCallback((filePath: string, offset?: number) => {
        const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
        if (!absolutePath) {
            return;
        }

        if (runtime?.editor) {
            void runtime.editor.openFile(absolutePath, offset);
            return;
        }

        // Dedicated mobile app: stage the same pending file focus/navigation
        // desktop uses, then surface the Files pane (workspace drawer tab),
        // which consumes it. Desktop grant flows don't apply here.
        if (mobileActions) {
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
            if (offset && Number.isFinite(offset)) {
                uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            } else {
                uiStore.openContextFile(contextDirectory, absolutePath);
            }
            mobileActions.openFiles();
            return;
        }

        if (!isFilePathWithinDirectory(absolutePath, currentDirectory)) {
            void ensureOutsideFileGrantForDesktop(absolutePath, currentDirectory).then(() => {
                const uiStore = useUIStore.getState();
                const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
                if (offset && Number.isFinite(offset)) {
                    uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                    return;
                }
                uiStore.openContextFile(contextDirectory, absolutePath);
            });
            return;
        }

        const uiStore = useUIStore.getState();
        const contextDirectory = getDirectoryForFilePath(currentDirectory, absolutePath);
        if (offset && Number.isFinite(offset)) {
            uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
            return;
        }
        uiStore.openContextFile(contextDirectory, absolutePath);
    }, [currentDirectory, mobileActions, runtime]);

    const normalizedToolName = toolName.toLowerCase();
    const isSearchGroup = normalizedToolName === 'grep'
        || normalizedToolName === 'search'
        || normalizedToolName === 'find'
        || normalizedToolName === 'ripgrep'
        || normalizedToolName === 'glob';
    const isFetchGroup = normalizedToolName === 'webfetch' || normalizedToolName === 'fetch' || normalizedToolName === 'curl' || normalizedToolName === 'wget';
    const isSkillGroup = normalizedToolName === 'skill';

    return (
        <div className="min-w-0">
        <div
            // oc-static-tool-row: on touch devices mobile.css raises this to the
            // same 36px floor the [role="button"] expandable/reasoning rows get,
            // so static and expandable rows have identical rhythm.
            className={cn(
                'oc-static-tool-row flex w-full items-center gap-x-1.5 pr-2 pl-px py-1.5 rounded-xl min-w-0'
            )}
        >
            <div className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                {icon}
            </div>
            <MinDurationShineText
                active={hasRunningActivity}
                minDurationMs={1000}
                className={cn(TOOL_ROW_TITLE_CLASS, 'inline-flex items-center flex-shrink-0 opacity-85')}
                style={{ color: 'var(--tools-title)' }}
                title={displayName}
            >
                {displayName}
            </MinDurationShineText>
            {isSearchGroup && descriptions.length > 0
                ? descriptions.map((desc, index) => (
                    <span key={`${desc}-${index}`} className="inline-flex min-w-0 flex-1">
                        <Text
                            variant={animateTailText ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                            style={{ color: 'var(--tools-description)' }}
                            title={desc}
                        >
                            "{desc}"
                        </Text>
                    </span>
                ))
                : null}
            {isFetchGroup && descriptions.length > 0
                ? descriptions.map((url, index) => (
                    <a
                        key={`${url}-${index}`}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(
                            'min-w-0 flex-1 inline-flex items-center gap-1.5 underline decoration-[color:var(--status-info)] underline-offset-2 hover:opacity-90',
                            'truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS
                        )}
                        style={{ color: 'var(--status-info)' }}
                        title={url}
                    >
                        <ExternalLinkFavicon href={url} />
                        <span className="min-w-0 truncate">{url}</span>
                    </a>
                ))
                : null}
            {isSkillGroup && skillEntries.length > 0
                ? skillEntries.map((entry, index) => (
                    <button
                        key={`${entry.name}-${entry.path}-${index}`}
                        type="button"
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            handleFileClick(entry.path);
                        }}
                        className={cn('!min-h-0 min-w-0 flex-1 truncate whitespace-nowrap text-left hover:opacity-90', TOOL_ROW_DESCRIPTION_CLASS)}
                        style={{ color: 'var(--tools-description)' }}
                        title={entry.path}
                    >
                        {entry.name}
                    </button>
                ))
                : null}
            {!isSearchGroup && !isFetchGroup && !isSkillGroup && descriptions.length > 0 ? (
                <Text
                    variant={animateTailText ? 'generate-effect' : 'static'}
                    className={cn('min-w-0 flex-1 truncate whitespace-nowrap', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    {descriptions.join(' ')}
                </Text>
            ) : null}
        </div>
        </div>
    );
};

export const StaticToolRow = React.memo(StaticToolRowInner, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
        && areActivityListsEqual(prev.activities, next.activities);
});

interface ExplorationToolGroupProps {
    id: string;
    activities: TurnActivityPart[];
    isExpanded: boolean;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    onContentChange?: (reason?: ContentChangeReason) => void;
    animateRows: boolean;
    animatedToolIds?: Set<string>;
}

export const ExplorationToolGroup = React.memo(({
    id,
    activities,
    isExpanded,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    animateRows,
    animatedToolIds,
}: ExplorationToolGroupProps) => {
    const { t } = useI18n();
    const contentId = `${id}-content`;
    const visibleActivities = React.useMemo(
        () => activities.filter((activity) => isExplorationPartDisplayReady(activity.part)),
        [activities],
    );
    const counts = React.useMemo(() => countExplorationTools(
        visibleActivities.map((activity) => (activity.part as ToolPartType).tool),
    ), [visibleActivities]);
    const summary = counts.search > 0 && counts.read > 0
        ? t('chat.activity.exploration.summary.searchesAndReads', {
            searchCount: counts.search,
            readCount: counts.read,
        })
        : counts.search > 0
            ? t('chat.activity.exploration.summary.searches', { searchCount: counts.search })
            : t('chat.activity.exploration.summary.reads', { readCount: counts.read });
    const handleToggle = React.useCallback(() => {
        onToggleTool(id);
        onContentChange?.('structural');
    }, [id, onContentChange, onToggleTool]);

    if (visibleActivities.length === 0) return null;

    return (
        <div data-exploration-group={id} className="min-w-0">
            <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={contentId}
                onClick={handleToggle}
                className="group/tool flex w-full min-w-0 items-center gap-1.5 rounded-xl py-1.5 pl-px pr-2 text-left"
            >
                <div className="flex flex-shrink-0 items-center gap-1.5">
                    <div className="relative size-3.5 flex-shrink-0">
                        <div
                            className={cn(
                                'absolute inset-0 transition-opacity',
                                isExpanded && 'opacity-0',
                                !isExpanded && 'group-hover/tool:opacity-0',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            <Icon name="search" className="size-3.5" />
                        </div>
                        <div
                            className={cn(
                                'absolute inset-0 flex items-center justify-center transition-opacity',
                                isExpanded && 'opacity-100',
                                !isExpanded && 'opacity-0 group-hover/tool:opacity-100',
                            )}
                            style={{ color: 'var(--tools-icon)' }}
                        >
                            {isExpanded
                                ? <Icon name="arrow-down-s" className="size-3.5" />
                                : <Icon name="arrow-right-s" className="size-3.5" />}
                        </div>
                    </div>
                    <span className={TOOL_ROW_TITLE_CLASS} style={{ color: 'var(--tools-title)' }}>
                        {t('chat.activity.exploration')}
                    </span>
                </div>
                <div
                    className={cn('flex min-w-0 flex-1 items-center gap-1', TOOL_ROW_DESCRIPTION_CLASS)}
                    style={{ color: 'var(--tools-description)' }}
                >
                    <span className="min-w-0 truncate opacity-80" title={summary}>{summary}</span>
                </div>
            </button>
            {isExpanded ? (
                <div id={contentId} className="relative ml-2 pb-1 pl-3 pt-0.5">
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute bottom-0 left-0 top-0 w-px"
                        style={{ backgroundColor: 'var(--tools-border)' }}
                    />
                    {visibleActivities.map((activity) => {
                        const toolName = normalizeToolName((activity.part as ToolPartType).tool);
                        if (isStaticTool(toolName)) {
                            return (
                                <MemoStaticGroupedToolRow
                                    key={activity.id}
                                    toolName={toolName}
                                    activities={[activity]}
                                    animateTailText={Boolean(animatedToolIds?.has(activity.id))}
                                    animateRows={animateRows}
                                />
                            );
                        }
                        return (
                            <MemoExpandableToolRow
                                key={activity.id}
                                activity={activity}
                                isExpanded={expandedTools.has(activity.id)}
                                isMobile={isMobile}
                                onToggleTool={onToggleTool}
                                onShowPopup={onShowPopup}
                                onContentChange={onContentChange}
                                animateTailText={Boolean(animatedToolIds?.has(activity.id))}
                                animateRows={animateRows}
                            />
                        );
                    })}
                </div>
            ) : null}
        </div>
    );
});

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock = React.memo(({ activity, onContentChange, streamPhase }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    streamPhase: StreamPhase;
}) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            streamPhase={streamPhase}
            onContentChange={onContentChange}
        />
    );
});

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock = React.memo(({ activity, onContentChange, actions }: {
    activity: TurnActivityPart;
    onContentChange?: (reason?: ContentChangeReason) => void;
    actions?: React.ReactNode;
}) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
            onContentChange={onContentChange}
            actions={actions}
            defaultExpanded
        />
    );
});

const ProgressiveGroup: React.FC<ProgressiveGroupProps> = ({
    parts,
    isExpanded,
    collapsedPreviewCount = 0,
    onToggle,
    isMobile,
    expandedTools,
    onToggleTool,
    onShowPopup,
    onContentChange,
    streamPhase,
    showHeader,
    animateRows = true,
    animatedToolIds,
    explorationGroups,
    renderJustificationActions,
}) => {
    const previewCount = showHeader && !isExpanded
        ? Math.max(0, Math.floor(collapsedPreviewCount))
        : 0;
    const shouldRenderRows = !showHeader || isExpanded || previewCount > 0;

    const sortedParts = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as TurnActivityPart[];
        }
        return sortPartsByTime(parts);
    }, [parts, shouldRenderRows]);

    const explorationGroupByPartId = React.useMemo(() => {
        const result = new Map<string, string>();
        explorationGroups?.forEach((group) => {
            group.parts.forEach((activity) => result.set(activity.id, group.id));
        });
        return result;
    }, [explorationGroups]);

    const rows = React.useMemo(() => {
        if (!shouldRenderRows) {
            return [] as AggregatedRow[];
        }
        return aggregateRows(sortedParts, explorationGroupByPartId);
    }, [explorationGroupByPartId, shouldRenderRows, sortedParts]);

    const previewHiddenCount = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return 0;
        }
        return Math.max(0, rows.length - previewCount);
    }, [isExpanded, previewCount, rows.length]);

    const visibleRows = React.useMemo(() => {
        if (isExpanded || previewCount === 0) {
            return rows;
        }
        return rows.slice(-previewCount);
    }, [isExpanded, previewCount, rows]);

    if (shouldRenderRows && rows.length === 0) {
        return null;
    }

    const wrapRow = (key: string, content: React.ReactNode) => {
        if (!animateRows) {
            return <React.Fragment key={key}>{content}</React.Fragment>;
        }
        return <FadeInOnReveal key={key}>{content}</FadeInOnReveal>;
    };

    const renderedRows = shouldRenderRows
        ? visibleRows.map((row, index) => {
        switch (row.type) {
            case 'reasoning':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineReasoningBlock
                            activity={row.activity}
                            streamPhase={streamPhase}
                            onContentChange={onContentChange}
                        />
                    </>
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            activity={row.activity}
                            onContentChange={onContentChange}
                            actions={renderJustificationActions?.(row.activity)}
                        />
                    </>
                );

            case 'tool-expandable':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'tool-static-group':
                return (
                    <MemoStaticGroupedToolRow
                        key={`static-${row.toolName}-${row.activities[0]?.id ?? index}`}
                        toolName={row.toolName}
                        activities={row.activities}
                        animateTailText={row.activities.some((activity) => animatedToolIds?.has(activity.id))}
                        animateRows={animateRows}
                    />
                );

            case 'exploration':
                return (
                    <ExplorationToolGroup
                        key={row.id}
                        id={row.id}
                        activities={row.activities}
                        isExpanded={expandedTools.has(row.id)}
                        isMobile={isMobile}
                        expandedTools={expandedTools}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateRows={animateRows}
                        animatedToolIds={animatedToolIds}
                    />
                );

            case 'tool-fallback':
                return (
                    <MemoExpandableToolRow
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        onContentChange={onContentChange}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                        animateRows={animateRows}
                    />
                );

            default:
                return null;
        }
    })
        : null;

    const shouldShowRowsContainer = isExpanded || visibleRows.length > 0;

    if (!showHeader) {
        return (
            <FadeInOnReveal>
                <div className="mt-1 mb-2">{renderedRows}</div>
            </FadeInOnReveal>
        );
    }

    return (
        <FadeInOnReveal>
            <div className="mt-1 mb-2">
                <button
                    type="button"
                    className="group/tool flex w-full flex-wrap items-center gap-x-2 gap-y-0.5 pr-2 pl-px py-1.5 rounded-xl text-left"
                    onClick={onToggle}
                >
                    <span className="inline-flex h-5 items-center flex-shrink-0" style={{ color: 'var(--tools-icon)' }}>
                        <Icon name="stack" className="h-3.5 w-3.5" />
                    </span>
                    <span
                        className="leading-5 font-semibold inline-flex h-5 items-center flex-shrink-0"
                        style={{
                            color: 'var(--tools-title)',
                            fontSize: '0.9rem',
                            letterSpacing: '0.005em',
                        }}
                    >
                        Activity
                    </span>
                </button>
                {shouldShowRowsContainer ? (
                    <div className="relative ml-2 pl-3">
                        <span
                            aria-hidden="true"
                            className="pointer-events-none absolute left-0 top-px bottom-0 w-px"
                            style={{ backgroundColor: 'var(--tools-border)' }}
                        />
                        {previewHiddenCount > 0 ? (
                            <button
                                type="button"
                                onClick={onToggle}
                                className="typography-meta leading-4 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} more...
                            </button>
                        ) : null}
                        <div>{renderedRows}</div>
                    </div>
                ) : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
