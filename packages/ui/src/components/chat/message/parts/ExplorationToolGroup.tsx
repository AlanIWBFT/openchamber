import React from 'react';
import type { TurnActivityRecord } from '../../lib/turns/types';
import type { ToolPopupContent } from '../types';
import { FadeInOnReveal } from '../FadeInOnReveal';
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
}

export const ExplorationToolGroup = React.memo(({
    id, activities, isExpanded, isMobile, expandedTools, onToggleTool, onShowPopup,
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
                        <ToolPart part={activity.part} isExpanded={expandedTools.has(activity.id)} isMobile={isMobile}
                            onToggle={onToggleTool} onShowPopup={onShowPopup} animateTailText={false} />
                </FadeInOnReveal>
            ) : null) : null}
        </ExplorationDisclosure>
    );
});
