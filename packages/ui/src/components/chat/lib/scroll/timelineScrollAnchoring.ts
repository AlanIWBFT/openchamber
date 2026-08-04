// Anchored-turn scroll geometry for the chat timeline.
//
// The timeline has three mutually exclusive scroll modes:
//
//   • `following-end`      — stay pinned to the live edge as content grows.
//   • `anchoring-new-turn` — the just-sent user message is parked near the TOP
//     of the viewport and the reply streams into reserved space below it. The
//     viewport does NOT move until the turn outgrows the usable viewport.
//   • `free-scrolling`     — the user took over; nothing moves the scroll
//     position until they opt back in.
//
// This module is pure geometry: it reads measurements from the virtualized
// list and answers "how far, if at all, must we scroll to reveal the end of
// the anchored turn". Keeping it free of DOM and React makes the mode machine
// testable without a renderer.
//
// "Usable viewport" is the visible height minus the composer overlay (the
// composer floats over the list) minus the anchor offset, so a turn is only
// considered overflowing when it genuinely cannot be read.

export type TimelineScrollMode = 'following-end' | 'anchoring-new-turn' | 'free-scrolling';

// Distance from the top of the viewport at which an anchored user message
// parks. Small enough to read as "at the top", large enough not to collide
// with the timeline's top fade.
export const CHAT_LIST_ANCHOR_OFFSET = 16;

export interface TimelineListMeasurementState {
    readonly data: readonly unknown[];
    readonly scroll: number;
    readonly scrollLength: number;
    readonly positionAtIndex: (index: number) => number | undefined;
    readonly sizeAtIndex: (index: number) => number | undefined;
}

export interface AnchoredTurnMetrics {
    readonly anchorTop: number;
    readonly lastBottom: number;
    readonly turnHeight: number;
    readonly usableViewportHeight: number;
    readonly visibleUsableBottom: number;
    readonly overflowsUsableViewport: boolean;
    readonly targetScrollToRevealEnd: number;
    readonly scrollDeltaToRevealEnd: number;
}

export const getRowBottom = (
    state: TimelineListMeasurementState,
    index: number,
): number | null => {
    const top = state.positionAtIndex(index);
    const height = state.sizeAtIndex(index);
    if (
        typeof top !== 'number'
        || typeof height !== 'number'
        || !Number.isFinite(top)
        || !Number.isFinite(height)
    ) {
        return null;
    }
    // Rows measured at zero height would make an anchored turn look empty and
    // suppress the reveal scroll; treat them as one pixel tall instead.
    return top + Math.max(1, height);
};

export const getAnchoredTurnMetrics = ({
    state,
    anchorIndex,
    composerOverlayHeight,
    anchorOffset,
}: {
    readonly state: TimelineListMeasurementState;
    readonly anchorIndex: number;
    readonly composerOverlayHeight: number;
    readonly anchorOffset: number;
}): AnchoredTurnMetrics | null => {
    if (state.data.length === 0) return null;

    const boundedAnchorIndex = Math.max(0, Math.min(anchorIndex, state.data.length - 1));
    const anchorTop = state.positionAtIndex(boundedAnchorIndex);
    // The LAST row bottom, not the content length: the reserved anchored end
    // space lives past it, and targeting that reserved tail would scroll the
    // real content off the top.
    const lastBottom = getRowBottom(state, state.data.length - 1);
    if (typeof anchorTop !== 'number' || !Number.isFinite(anchorTop) || lastBottom === null) {
        return null;
    }

    const usableViewportHeight = Math.max(
        0,
        state.scrollLength - composerOverlayHeight - anchorOffset,
    );
    const turnHeight = Math.max(0, lastBottom - anchorTop);
    const visibleUsableBottom = state.scroll + usableViewportHeight;
    const targetScrollToRevealEnd = Math.max(0, lastBottom - usableViewportHeight);
    // Never negative: revealing the end must not scroll the timeline backwards.
    const scrollDeltaToRevealEnd = Math.max(0, targetScrollToRevealEnd - state.scroll);

    return {
        anchorTop,
        lastBottom,
        turnHeight,
        usableViewportHeight,
        visibleUsableBottom,
        overflowsUsableViewport: turnHeight > usableViewportHeight,
        targetScrollToRevealEnd,
        scrollDeltaToRevealEnd,
    };
};

// "At the end" for follow purposes is the NEAR-end threshold, not the exact
// content bottom: the timeline's footer (status row plus bottom spacer) sits
// below the last row, so requiring the exact bottom would drop out of follow —
// and pop the scroll-to-bottom pill — while the user is still looking at the
// live edge. `isAtEnd` is only the fallback for states that predate the
// near-end signal.
export const resolveTimelineIsAtEnd = (
    state: { readonly isNearEnd?: boolean; readonly isAtEnd?: boolean } | undefined,
): boolean | undefined => state?.isNearEnd ?? state?.isAtEnd;

export interface ChatListAnchoredEndSpace {
    readonly anchorIndex: number;
    readonly anchorOffset: number;
}

// Finds the anchored row from the BACK of the list: a retried or re-sent
// message id can appear more than once, and the live one is always the last.
export const resolveChatListAnchoredEndSpace = <Item, AnchorId>(
    items: readonly Item[],
    anchorId: AnchorId | null,
    getAnchorId: (item: Item) => AnchorId | null,
    options: { readonly anchorOffset?: number } = {},
): ChatListAnchoredEndSpace | undefined => {
    if (anchorId === null) return undefined;

    for (let index = items.length - 1; index >= 0; index -= 1) {
        const item = items[index];
        if (item !== undefined && getAnchorId(item) === anchorId) {
            return {
                anchorIndex: index,
                anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
            };
        }
    }

    return undefined;
};
