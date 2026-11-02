import React from 'react';

const TURN_EXPANSION_CACHE_MAX = 4000;
const turnExpansionCache = new Map<string, boolean>();
let turnExpansionCacheMode: string | null = null;

const readTurnExpansionCache = (activityRenderMode: string): Map<string, boolean> => {
    if (turnExpansionCacheMode !== activityRenderMode) {
        turnExpansionCache.clear();
        turnExpansionCacheMode = activityRenderMode;
    }
    return new Map(turnExpansionCache);
};

const writeTurnExpansionCache = (turnId: string, expanded: boolean): void => {
    turnExpansionCache.delete(turnId);
    turnExpansionCache.set(turnId, expanded);
    if (turnExpansionCache.size > TURN_EXPANSION_CACHE_MAX) {
        const oldest = turnExpansionCache.keys().next().value;
        if (oldest !== undefined) turnExpansionCache.delete(oldest);
    }
};

export const useTurnExpansion = (activityRenderMode: string) => {
    const defaultExpanded = activityRenderMode === 'summary';
    const [turnExpansion, setTurnExpansion] = React.useState<Map<string, boolean>>(() => readTurnExpansionCache(activityRenderMode));

    const turnExpansionModeRef = React.useRef(activityRenderMode);
    React.useEffect(() => {
        if (turnExpansionModeRef.current === activityRenderMode) return;
        turnExpansionModeRef.current = activityRenderMode;
        setTurnExpansion(readTurnExpansionCache(activityRenderMode));
    }, [activityRenderMode]);

    const toggleTurnActivity = React.useCallback((turnId: string) => {
        setTurnExpansion((previous) => {
            const expanded = !(previous.get(turnId) ?? defaultExpanded);
            writeTurnExpansionCache(turnId, expanded);
            return new Map(previous).set(turnId, expanded);
        });
    }, [defaultExpanded]);

    const turnExpansionRef = React.useRef(turnExpansion);
    turnExpansionRef.current = turnExpansion;

    const expandTurnActivity = React.useCallback((foldIds: string[]): boolean => {
        const folded = foldIds.filter((id) => !(turnExpansionRef.current.get(id) ?? defaultExpanded));
        if (!folded.length) return false;
        for (const id of folded) writeTurnExpansionCache(id, true);
        setTurnExpansion((previous) => {
            const next = new Map(previous);
            for (const id of folded) next.set(id, true);
            return next;
        });
        return true;
    }, [defaultExpanded]);

    return { turnExpansion, toggleTurnActivity, expandTurnActivity };
};
