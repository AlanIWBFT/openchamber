import React from 'react';
import type { TurnActivityRecord } from '../../lib/turns/types';
import type { ToolPopupContent } from '../types';
import { FadeInOnReveal } from '../FadeInOnReveal';
import { ToolRevealOnMount } from './ToolRevealOnMount';
import ToolPart from './ToolPart';
import { ExplorationDisclosure } from './ExplorationDisclosure';
import { countExplorationTools, isExplorationPartDisplayReady } from './toolRenderUtils';

interface ExplorationToolGroupProps {
    id: string;
    activities: TurnActivityRecord[];
    isExpanded: boolean;
    isMobile: boolean;
    expandedTools: Set<string>;
    onToggleTool: (toolId: string) => void;
    onShowPopup: (content: ToolPopupContent) => void;
    animatedToolIds?: Set<string>;
}

export const ExplorationToolGroup = React.memo(({
    id, activities, isExpanded, isMobile, expandedTools, onToggleTool, onShowPopup, animatedToolIds,
}: ExplorationToolGroupProps) => {
    const visibleActivities = React.useMemo(() => activities.filter((activity) => isExplorationPartDisplayReady(activity.part)), [activities]);
    const counts = React.useMemo(() => countExplorationTools(
        visibleActivities.map((activity) => activity.part.type === 'tool' ? activity.part.tool : undefined),
    ), [visibleActivities]);
    if (visibleActivities.length === 0) return null;
    return (
        <ExplorationDisclosure id={id} counts={counts} isExpanded={isExpanded} onToggle={onToggleTool}>
            {isExpanded ? visibleActivities.map((activity) => activity.part.type === 'tool' ? (
                <FadeInOnReveal key={activity.id}>
                    <ToolRevealOnMount animate={Boolean(animatedToolIds?.has(activity.id))} wipe>
                        <ToolPart part={activity.part} isExpanded={expandedTools.has(activity.id)} isMobile={isMobile}
                            onToggle={onToggleTool} onShowPopup={onShowPopup} animateTailText={Boolean(animatedToolIds?.has(activity.id))} />
                    </ToolRevealOnMount>
                </FadeInOnReveal>
            ) : null) : null}
        </ExplorationDisclosure>
    );
});
