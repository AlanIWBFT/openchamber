import { isExecuteTool, isSkillTool, normalizeToolName, toolDescription } from '@/lib/opencode/tools';
import React from 'react';
import { pixelFontSize } from '@/lib/typography';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { cn } from '@/lib/utils';
import type { TurnActivityRecord as TurnActivityPart, TurnExplorationGroup } from '../../lib/turns/types';
import type { Metadata, ToolInput, ToolPart as ToolPartType } from '@/lib/opencode/model';
import type { StreamPhase } from '../types';
import type { ToolPopupContent } from '../types';
import ToolPart, { type ToolExpansionState } from './ToolPart';
import { BlockLine } from './BlockLine';
import { MinDurationShineText } from './MinDurationShineText';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import { Text } from '@/components/ui/text';
import { Icon } from "@/components/icon/Icon";
import { FadeInOnReveal } from '../FadeInOnReveal';
import { getToolIcon } from './toolPresentation';
import { getToolMetadata } from '@/lib/toolHelpers';
import { useGuestToolPresentation } from '@/lib/guests/tool-presentation';
import { countExplorationTools, isExpandableTool, isExplorationPartDisplayReady, isExplorationTool, isStandaloneTool, isStaticTool } from './toolRenderUtils';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import ReasoningPart from './ReasoningPart';
import JustificationBlock from './JustificationBlock';
import { ExplorationDisclosure } from './ExplorationDisclosure';
import { areRenderRelevantPartsEqual } from '../renderCompare';
import { getExternalFaviconUrl } from '@/lib/url';
import { getDirectoryForFilePath, isFilePathWithinDirectory, normalizeFilePath, toAbsoluteFilePath } from '@/lib/path-utils';

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

const resolveSkillFilePath = (skillPathOrDir: string): string => {
    const normalizedPath = normalizeFilePath(skillPathOrDir);
    if (!normalizedPath) {
        return '';
    }

    return normalizedPath.toLowerCase().endsWith('/skill.md') ? normalizedPath : `${normalizedPath}/SKILL.md`;
};

/**
 * Short description for a static tool row (aggregation display). Tool naming
 * and per-tool input fields live in `@/lib/opencode/tools`; this only trims
 * the result to the row's width and falls back to a bare file name.
 */
const SHORT_DESCRIPTION_MAX = 50;

const getToolShortDescription = (activity: TurnActivityPart): string | null => {
    const part = activity.part as ToolPartType;
    const state = part.state as { input?: ToolInput; metadata?: Metadata } | undefined;
    const described = toolDescription(part.tool, state?.input, state?.metadata);

    if (described?.kind === 'text') {
        return described.value.length > SHORT_DESCRIPTION_MAX
            ? `${described.value.slice(0, SHORT_DESCRIPTION_MAX)}...`
            : described.value;
    }
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
    nestedTools?: ToolExpansionState;
    activity: TurnActivityPart;
    isExpanded: boolean;
    isMobile: boolean;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    animateTailText: boolean;
}

const ExpandableToolRow: React.FC<ExpandableToolRowProps> = ({
    nestedTools,
    activity,
    isExpanded,
    isMobile,
    onToggleTool,
    onShowPopup,
    animateTailText,
}) => {
    const handleToggle = React.useCallback(() => {
        onToggleTool(activity.id);
    }, [activity.id, onToggleTool]);

    const content = (
        <ToolPart
            nestedTools={nestedTools}
            part={activity.part as ToolPartType}
            isExpanded={isExpanded}
            onToggle={handleToggle}
            isMobile={isMobile}
            onShowPopup={onShowPopup}
            animateTailText={animateTailText}
        />
    );

    // Wrappers are unconditional: a conditional wrapper changes the element
    // type at this position when animateTailText/animateRows flip (message
    // completion), remounting the tool subtree and replaying the reveal wipe.
    // Both wrappers are inert with animation off.
    return (
        <FadeInOnReveal>
            <ToolRevealOnMount animate={animateTailText} wipe>
                {content}
            </ToolRevealOnMount>
        </FadeInOnReveal>
    );
};

const MemoExpandableToolRow = React.memo(ExpandableToolRow, (prev, next) => {
    return prev.isExpanded === next.isExpanded
        && prev.nestedTools === next.nestedTools
        && prev.isMobile === next.isMobile
        && prev.onToggleTool === next.onToggleTool
        && prev.onShowPopup === next.onShowPopup
        && prev.animateTailText === next.animateTailText
        && prev.activity.id === next.activity.id
        && prev.activity.kind === next.activity.kind
        && prev.activity.endedAt === next.activity.endedAt
        && areRenderRelevantPartsEqual([prev.activity.part], [next.activity.part]);
});

interface StaticGroupedToolRowProps {
    toolName: string;
    activities: TurnActivityPart[];
    animateTailText: boolean;
}

const StaticGroupedToolRow: React.FC<StaticGroupedToolRowProps> = ({
    toolName,
    activities,
    animateTailText,
}) => {
    const content = (
        <StaticToolRow
            toolName={toolName}
            activities={activities}
            animateTailText={animateTailText}
        />
    );

    // Wrappers are unconditional: a conditional wrapper changes the element
    // type at this position when animateTailText/animateRows flip (message
    // completion), remounting the tool subtree and replaying the reveal wipe.
    // Both wrappers are inert with animation off.
    return (
        <FadeInOnReveal>
            <ToolRevealOnMount animate={animateTailText} wipe>
                {content}
            </ToolRevealOnMount>
        </FadeInOnReveal>
    );
};

const MemoStaticGroupedToolRow = React.memo(StaticGroupedToolRow, (prev, next) => {
    return prev.toolName === next.toolName
        && prev.animateTailText === next.animateTailText
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
                    || next.part.type !== 'tool'
                    || !isExplorationTool(next.part.tool)
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
    // Grouped rows share one normalized name; the registry wants the full
    // name OpenCode reported, which every activity in the group carries.
    const firstPart = activities[0]?.part;
    const presentation = useGuestToolPresentation(firstPart?.type === 'tool' ? firstPart.tool : null);
    const displayName = presentation?.name ?? getToolMetadata(toolName).displayName;
    const icon = getToolIcon(toolName, presentation);
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
        if (!isSkillTool(toolName)) return [] as Array<{ name: string; path: string }>;

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
        // which consumes it.
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
            const uiStore = useUIStore.getState();
            const contextDirectory = currentDirectory || getDirectoryForFilePath(currentDirectory, absolutePath);
            if (offset && Number.isFinite(offset)) {
                uiStore.openContextFileAtLine(contextDirectory, absolutePath, Math.max(1, Math.trunc(offset)), 1);
                return;
            }
            uiStore.openContextFile(contextDirectory, absolutePath);
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
    const isSkillGroup = isSkillTool(normalizedToolName);

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
    animatedToolIds,
}: ExplorationToolGroupProps) => {
    const visibleActivities = React.useMemo(
        () => activities.filter((activity) => isExplorationPartDisplayReady(activity.part)),
        [activities],
    );
    const counts = React.useMemo(() => countExplorationTools(
        visibleActivities.map((activity) => activity.part.type === 'tool' ? activity.part.tool : undefined),
    ), [visibleActivities]);

    if (visibleActivities.length === 0) return null;

    return (
        <ExplorationDisclosure id={id} counts={counts} isExpanded={isExpanded} onToggle={onToggleTool}>
            {isExpanded ? (
                <>
                    {visibleActivities.map((activity) => {
                        if (activity.part.type !== 'tool') return null;
                        const toolName = normalizeToolName(activity.part.tool);
                        if (isStaticTool(toolName)) {
                            return (
                                <MemoStaticGroupedToolRow
                                    key={activity.id}
                                    toolName={toolName}
                                    activities={[activity]}
                                    animateTailText={Boolean(animatedToolIds?.has(activity.id))}
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
                                animateTailText={Boolean(animatedToolIds?.has(activity.id))}
                            />
                        );
                    })}
                </>
            ) : null}
        </ExplorationDisclosure>
    );
});

/**
 * Inline reasoning text block — rendered as dimmed italic markdown.
 */
const InlineReasoningBlock = React.memo(({ activity, streamPhase }: {
    activity: TurnActivityPart;
    streamPhase: StreamPhase;
}) => {
    return (
        <ReasoningPart
            part={activity.part}
            messageId={activity.messageId}
            streamPhase={streamPhase}
        />
    );
});

/**
 * Inline justification text block — rendered as normal assistant text between tools.
 */
const InlineJustificationBlock = React.memo(({ activity, actions }: {
    activity: TurnActivityPart;
    actions?: React.ReactNode;
}) => {
    return (
        <JustificationBlock
            part={activity.part}
            messageId={activity.messageId}
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
    streamPhase,
    showHeader,
    animateRows = true,
    animatedToolIds,
    explorationGroups,
    renderJustificationActions,
}) => {
    const nestedTools = React.useMemo(() => ({ expanded: expandedTools, toggle: onToggleTool }), [expandedTools, onToggleTool]);
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
                        />
                    </>
                );

            case 'justification':
                return wrapRow(
                    row.activity.id,
                    <>
                        <InlineJustificationBlock
                            activity={row.activity}
                            actions={renderJustificationActions?.(row.activity)}
                        />
                    </>
                );

            case 'tool-expandable':
                return (
                    <MemoExpandableToolRow
                        nestedTools={row.activity.part.type === 'tool' && isExecuteTool(row.activity.part.tool) ? nestedTools : undefined}
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
                    />
                );

            case 'tool-static-group':
                return (
                    <MemoStaticGroupedToolRow
                        key={`static-${row.toolName}-${row.activities[0]?.id ?? index}`}
                        toolName={row.toolName}
                        activities={row.activities}
                        animateTailText={row.activities.some((activity) => animatedToolIds?.has(activity.id))}
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
                        animatedToolIds={animatedToolIds}
                    />
                );

            case 'tool-fallback':
                return (
                    <MemoExpandableToolRow
                        nestedTools={row.activity.part.type === 'tool' && isExecuteTool(row.activity.part.tool) ? nestedTools : undefined}
                        key={row.activity.id}
                        activity={row.activity}
                        isExpanded={expandedTools.has(row.activity.id)}
                        isMobile={isMobile}
                        onToggleTool={onToggleTool}
                        onShowPopup={onShowPopup}
                        animateTailText={Boolean(animatedToolIds?.has(row.activity.id))}
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
                            fontSize: pixelFontSize('0.9rem'),
                            letterSpacing: '0.005em',
                        }}
                    >
                        Activity
                    </span>
                </button>
                {shouldShowRowsContainer ? (
                    <div className="relative ml-2 pl-3">
                        <BlockLine onToggle={onToggle} topOffset={1} />
                        {previewHiddenCount > 0 ? (
                            <button
                                type="button"
                                onClick={onToggle}
                                className="typography-meta leading-4 px-2 py-1 text-muted-foreground/45 hover:text-muted-foreground/65 text-left"
                            >
                                +{previewHiddenCount} more...
                            </button>
                        ) : null}
                        {/* No gap between rows: each row carries its own padding, and
                            the live timeline stacks the same rows with nothing between
                            them, so the sorted view keeps the identical rhythm. */}
                        <div>{renderedRows}</div>
                    </div>
                ) : null}
            </div>
        </FadeInOnReveal>
    );
};

export default React.memo(ProgressiveGroup);
