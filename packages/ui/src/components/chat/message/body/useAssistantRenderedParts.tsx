import { SegmentContext } from '../../components/toolSegmentContext';
import { ToolSegmentDisclosure } from '../../components/ToolSegmentDisclosure';
import { hiddenToolCount, hiddenToolRow } from '../../lib/turns/toolSegments';
import React from 'react';
import { ExplorationToolGroup } from '../parts/ExplorationToolGroup';
import type { Part, ToolPart as ToolPartType } from '@/lib/opencode/model';
import type { StreamPhase, ToolPopupContent } from '../types';
import type { TurnGroupingContext } from '../../lib/turns/types';
import ToolPart from '../parts/ToolPart';
import AssistantTextPart from '../parts/AssistantTextPart';
import ReasoningPart from '../parts/ReasoningPart';
import { isInvisibleText } from '@/lib/invisibleText';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { SessionNoticeBlock } from '../SessionNoticeBlock';
import { readSessionNoticePart } from '@/lib/opencode/session-notices';
import { StaticToolRow } from '../parts/ProgressiveGroup';
import { isExpandableTool } from '../parts/toolRenderUtils';
import { ShownToolCard } from '../parts/ShownToolCard';
import { isExecuteTool, isShownInPlace } from '@/lib/opencode/tools';
import { isToolRowShown } from '../../lib/turns/activityRows';
import { MessageSliceContext } from '../messageSliceContext';
import { MessageSelectionMark } from '../../messageSelection/MessageSelectionMark';
import { useUIStore } from '@/stores/useUIStore';
import { INLINE_MESSAGE_ACTIONS_CLASS_NAME } from './messageBodyStyles';

export const useAssistantRenderedParts = ({
    messageId,
    sessionId,
    visibleParts,
    messageTextContentRef,
    messageActionButtons,
    answerSelectionKey,
    effectiveStreamPhase,
    turnGroupingContext,
    showReasoningTraces,
    expandedTools,
    onToggleTool,
    onShowPopup,
    isMobile,
    alwaysShowMessageActions,
    shouldShowStandaloneMessageActions,
    lastRenderableTextPartIndex,
}: {
    messageId: string;
    sessionId: string | undefined;
    visibleParts: Part[];
    messageTextContentRef: React.RefObject<HTMLDivElement | null>;
    messageActionButtons: React.ReactNode;
    answerSelectionKey: string | null;
    effectiveStreamPhase: StreamPhase;
    turnGroupingContext: TurnGroupingContext | undefined;
    showReasoningTraces: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    isMobile: boolean;
    alwaysShowMessageActions: boolean;
    shouldShowStandaloneMessageActions: boolean;
    lastRenderableTextPartIndex: number;
}) => {
    const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
    const segments = React.useContext(SegmentContext);
    const slice = React.useContext(MessageSliceContext);
    const nestedTools = React.useMemo(() => ({ expanded: expandedTools, toggle: onToggleTool }), [expandedTools, onToggleTool]);

    return React.useMemo(() => {
        const explorationGroups = new Map((turnGroupingContext?.explorationGroups ?? []).flatMap((group) => {
            const first = group.parts[0];
            return first ? [[first.id, group] as const] : [];
        }));
        const explorationPartIds = new Set(turnGroupingContext?.explorationPartIds ?? []);
        const rendered: React.ReactNode[] = [];
        let sliceStarted = !slice?.from;
        const firstTextPartId = visibleParts.find((candidate) => candidate.type === 'text')?.id;
        let i = 0;
        while (i < visibleParts.length) {
            const part = visibleParts[i];
            if (!sliceStarted) {
                sliceStarted = part.id === slice?.from?.partId;
                if (!sliceStarted) {
                    i += 1;
                    continue;
                }
            }
            if (slice?.to && (slice.to.offset === 0 ? part.id === slice.to.partId : visibleParts[i - 1]?.id === slice.to.partId)) break;
            const position = segments?.index.byPart.get(part.id);
            if (segments && position) {
                if (position.index === 0 && hiddenToolCount(position.segment, segments.preview)) {
                    rendered.push(<ToolSegmentDisclosure key={`segment:${part.id}`} segment={position.segment} selectionKey={segments.index.hasAnswerText ? answerSelectionKey : null} />);
                }
                if (hiddenToolRow(part, position, segments.expanded(position.segment.id), segments.preview)) { i++; continue; }
            }

            if (part.type === 'text') {
                const textStart = slice?.from?.partId === part.id ? slice.from.offset : 0;
                const textEnd = slice?.to?.partId === part.id && slice.to.offset > 0 ? slice.to.offset : undefined;
                rendered.push(
                    <div
                        key={`assistant-text-${messageId}-${i}`}
                        ref={messageTextContentRef}
                        data-message-text-export-source="true"
                        data-message-select-unit={answerSelectionKey ?? undefined}
                    >
                        <MessageSelectionMark
                            sessionId={sessionId}
                            unitKey={answerSelectionKey}
                            kind="answer"
                            showCheckbox={Boolean(turnGroupingContext?.opensAnswerText) && part.id === firstTextPartId && textStart === 0}
                        />
                        <AssistantTextPart
                            part={part}
                            sessionId={sessionId}
                            messageId={messageId}
                            streamPhase={effectiveStreamPhase}
                            onShowPopup={onShowPopup}
                            range={textStart > 0 || textEnd !== undefined ? { start: textStart, end: textEnd } : undefined}
                        />
                    </div>
                );
                if (shouldShowStandaloneMessageActions && i === lastRenderableTextPartIndex) {
                    rendered.push(
                        <div key={`message-actions-${messageId}`} className={INLINE_MESSAGE_ACTIONS_CLASS_NAME} data-message-actions="true">
                            <div className="flex items-center gap-1.5" data-message-action-group="true">
                                {messageActionButtons}
                            </div>
                        </div>
                    );
                }
                i++;
                continue;
            }

            if (part.type === 'reasoning') {
                const reasoningEnded = part.time?.end !== undefined
                    || (effectiveStreamPhase !== 'streaming' && effectiveStreamPhase !== 'cooldown');
                if (showReasoningTraces && !(reasoningEnded && isInvisibleText(part.text))) {
                    if (!collapsibleThinkingBlocks) {
                        rendered.push(
                            <AssistantTextPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                sessionId={sessionId}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                                onShowPopup={onShowPopup}
                            />
                        );
                    } else {
                        rendered.push(
                            <ReasoningPart
                                key={`reasoning-${messageId}-${i}`}
                                part={part}
                                messageId={messageId}
                                streamPhase={effectiveStreamPhase}
                            />
                        );
                    }
                }
                i++;
                continue;
            }

            if (part.type === 'tool') {
                const toolPart = part as ToolPartType;
                const toolName = toolPart.tool?.toLowerCase() ?? '';

                const notice = readSessionNoticePart(toolPart);
                if (notice) {
                    rendered.push(
                        <FadeInOnReveal key={`notice-${toolPart.id}`}>
                            <SessionNoticeBlock notice={notice} blockId={toolPart.id} />
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                const explorationGroup = explorationGroups.get(toolPart.id);
                if (explorationGroup) {
                    rendered.push(<ExplorationToolGroup key={explorationGroup.id} id={explorationGroup.id} activities={explorationGroup.parts}
                        isExpanded={expandedTools.has(explorationGroup.id)} isMobile={isMobile} expandedTools={expandedTools}
                        onToggleTool={onToggleTool} onShowPopup={onShowPopup} />);
                    i++;
                    continue;
                }
                if (explorationPartIds.has(toolPart.id)) {
                    i++;
                    continue;
                }
                if (!isToolRowShown(toolPart)) {
                    i++;
                    continue;
                }

                if (isShownInPlace(toolPart.tool, toolPart.state)) {
                    rendered.push(<ShownToolCard key={`page-${toolPart.id}`} part={toolPart} onShowPopup={onShowPopup} />);
                    i++;
                    continue;
                }

                if (isExpandableTool(toolName)) {
                    rendered.push(
                        <FadeInOnReveal key={`tool-${toolPart.id}`}>
                            <ToolPart
                                part={toolPart}
                                isExpanded={expandedTools.has(toolPart.id)}
                                onToggle={onToggleTool}
                                nestedTools={isExecuteTool(toolPart.tool) ? nestedTools : undefined}
                                isMobile={isMobile}
                                alwaysShowActions={alwaysShowMessageActions}
                                onShowPopup={onShowPopup}
                                animateTailText={false}
                            />
                        </FadeInOnReveal>
                    );
                    i++;
                    continue;
                }

                rendered.push(
                    <FadeInOnReveal key={`static-tools-${toolPart.id}`}>
                        <StaticToolRow
                            toolName={toolName}
                            activities={[
                                {
                                    id: toolPart.id,
                                    turnId: '',
                                    messageId,
                                    partIndex: 0,
                                    part: toolPart,
                                    kind: 'tool' as const,
                                },
                            ]}
                            animateTailText={false}
                        />
                    </FadeInOnReveal>
                );
                i++;
                continue;
            }

            i++;
        }

        return rendered;
    }, [
        alwaysShowMessageActions,
        collapsibleThinkingBlocks,
        expandedTools,
        isMobile,
        segments,
        lastRenderableTextPartIndex,
        messageId,
        messageActionButtons,
        messageTextContentRef,
        sessionId,
        onShowPopup,
        onToggleTool,
        nestedTools,
        shouldShowStandaloneMessageActions,
        effectiveStreamPhase,
        showReasoningTraces,
        slice,
        turnGroupingContext,
        visibleParts,
        answerSelectionKey,
    ]);
};
