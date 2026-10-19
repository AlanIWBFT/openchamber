import React from 'react';

import { useUIStore } from '@/stores/useUIStore';
import type { ChatMessageEntry, TurnExplorationGroup } from '../lib/turns/types';
import { ActivityRowSkipContext, activityRowParts, createActivityRowPredicate } from '../lib/turns/activityRows';
import { LiveTurnHoistedPagesContext, LiveTurnHoistedCommandsContext } from './liveActivityContext';
import {
    TURN_ROW_REVEAL_CHUNK,
    TurnMessageWindowContext,
    FULL_MESSAGE_WINDOW,
    initialMessageWindow,
    resolveMountedMessages,
    shouldHoldRevealAnchor,
    type TurnMessageWindowRange,
} from '../lib/turns/turnMessageWindow';
import { CHAT_SCROLLER_SELECTOR, holdAnchor } from '../lib/scroll/holdAnchor';

// Stands in for a not yet mounted row until it mounts and measures.
const ESTIMATED_ROW_HEIGHT_PX = 40;
const subscribeNowhere = () => () => {};
const NO_GROUPS: readonly TurnExplorationGroup[] = [];

/**
 * Mounts the next batch once a spacer comes within a viewport of the
 * visible area; a spacer already on screen mounts everything it holds, since
 * a reader looking at it would otherwise watch it fill batch by batch.
 * Observed afresh after every batch: a new observation reports the current
 * intersection, so a spacer still near the viewport keeps going.
 */
const useSpacerReveal = (
    spacerRef: React.RefObject<HTMLDivElement | null>,
    hidden: number,
    reveal: (nextHidden: number) => void,
) => {
    React.useEffect(() => {
        const spacer = spacerRef.current;
        const scroller = spacer?.closest(CHAT_SCROLLER_SELECTOR);
        if (!spacer || !scroller) return;
        const observer = new IntersectionObserver((entries) => {
            if (!entries[entries.length - 1]?.isIntersecting) return;
            const view = scroller.getBoundingClientRect();
            const rect = spacer.getBoundingClientRect();
            const onScreen = rect.bottom > view.top && rect.top < view.bottom;
            reveal(onScreen ? 0 : Math.max(0, hidden - TURN_ROW_REVEAL_CHUNK));
        }, { root: scroller, rootMargin: '100% 0px' });
        observer.observe(spacer);
        return () => observer.disconnect();
    }, [hidden, reveal, spacerRef]);
};

interface TurnMessageWindowProps {
    explorationGroups?: readonly TurnExplorationGroup[];
    turnId: string;
    messages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    /** Already-projected previews mount in full without reading or changing the history window. */
    windowed?: boolean;
}

/**
 * A turn's assistant messages, with the rows of a long turn outside its
 * window held behind spacers until they come near the viewport (see
 * turnMessageWindow). Mounting a batch above the reader keeps the message
 * they were looking at still.
 */
export function TurnMessageWindow({ turnId, messages, renderMessage, windowed = true, explorationGroups = NO_GROUPS }: TurnMessageWindowProps) {
    const windowStore = React.useContext(TurnMessageWindowContext);
    const store = windowed ? windowStore : null;
    const outerRowSkip = React.useContext(ActivityRowSkipContext);
    const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
    const hoistedPages = React.useContext(LiveTurnHoistedPagesContext);
    const hoistedCommands = React.useContext(LiveTurnHoistedCommandsContext);
    const rowParts = React.useMemo(() => {
        const isRow = createActivityRowPredicate(explorationGroups, new Set([...(hoistedPages ?? []), ...(hoistedCommands ?? [])]));
        return messages.map((message) => activityRowParts(message.parts, showReasoningTraces, isRow));
    }, [messages, showReasoningTraces, explorationGroups, hoistedPages, hoistedCommands]);
    // Rows a folded live activity already skips (its trim cuts into its first
    // shown message) are not rows of this window.
    const rowsPerMessage = React.useMemo(
        () => messages.map((message, index) => {
            const rows = rowParts[index].length;
            return outerRowSkip?.messageId === message.info.id ? Math.max(0, rows - outerRowSkip.rows) : rows;
        }),
        [messages, outerRowSkip, rowParts],
    );
    const initialRange = React.useMemo(() => initialMessageWindow(rowsPerMessage.reduce((total, rows) => total + rows, 0)), [rowsPerMessage]);
    const storedRange = React.useSyncExternalStore(
        store?.subscribe ?? subscribeNowhere,
        () => store?.range(turnId),
    );
    const range: TurnMessageWindowRange = store ? storedRange ?? initialRange : FULL_MESSAGE_WINDOW;
    const mounted = resolveMountedMessages(rowsPerMessage, range);
    const { hiddenHeadRows, hiddenTailRows } = mounted;

    const headSpacerRef = React.useRef<HTMLDivElement | null>(null);
    const tailSpacerRef = React.useRef<HTMLDivElement | null>(null);
    const anchorRef = React.useRef<{ element: Element; top: number } | null>(null);

    React.useLayoutEffect(() => {
        if (store && store.range(turnId) === undefined) store.setRange(turnId, initialRange);
    }, [initialRange, store, turnId]);

    const revealHead = React.useCallback((nextHidden: number) => {
        const spacer = headSpacerRef.current;
        const scroller = spacer?.closest(CHAT_SCROLLER_SELECTOR);
        const firstMounted = spacer?.nextElementSibling;
        anchorRef.current = null;
        if (spacer && scroller && firstMounted) {
            const view = scroller.getBoundingClientRect();
            const top = firstMounted.getBoundingClientRect().top;
            if (shouldHoldRevealAnchor({
                spacerTop: spacer.getBoundingClientRect().top,
                firstMountedTop: top,
                viewTop: view.top,
                viewBottom: view.bottom,
            })) {
                anchorRef.current = { element: firstMounted, top };
            }
        }
        const current = store?.range(turnId) ?? FULL_MESSAGE_WINDOW;
        store?.setRange(turnId, { ...current, hiddenHead: nextHidden });
    }, [store, turnId]);

    const revealTail = React.useCallback((nextHidden: number) => {
        const current = store?.range(turnId) ?? FULL_MESSAGE_WINDOW;
        store?.setRange(turnId, { ...current, hiddenTail: nextHidden });
    }, [store, turnId]);

    React.useLayoutEffect(() => {
        const anchor = anchorRef.current;
        anchorRef.current = null;
        if (!anchor?.element.isConnected) return;
        const scroller = anchor.element.closest(CHAT_SCROLLER_SELECTOR);
        if (!scroller) return;
        return holdAnchor(scroller, anchor.element, anchor.top);
    }, [hiddenHeadRows]);

    useSpacerReveal(headSpacerRef, hiddenHeadRows, revealHead);
    useSpacerReveal(tailSpacerRef, hiddenTailRows, revealTail);

    const visibleMessages = mounted.headMessages > 0 || mounted.tailMessages > 0
        ? messages.slice(mounted.headMessages, messages.length - mounted.tailMessages)
        : messages;
    // The message the head cuts into skips its first rows, after any the outer
    // trim skips there. Every message sits in a provider, so the one that
    // stops being cut into keeps its tree.
    const cutMessageId = mounted.headSkipRows > 0 ? visibleMessages[0]?.info.id : undefined;
    const outerSkipOfCut = outerRowSkip && outerRowSkip.messageId === cutMessageId ? outerRowSkip.rows : 0;
    const headRowSkip = React.useMemo(
        () => (cutMessageId ? {
            messageId: cutMessageId,
            rows: outerSkipOfCut + mounted.headSkipRows,
            partIds: new Set(rowParts[mounted.headMessages].slice(0, outerSkipOfCut + mounted.headSkipRows).map((part) => part.id)),
        } : null),
        [cutMessageId, mounted.headMessages, mounted.headSkipRows, outerSkipOfCut, rowParts],
    );
    return (
        <>
            {hiddenHeadRows > 0 ? (
                <div
                    ref={headSpacerRef}
                    aria-hidden="true"
                    data-turn-message-spacer="head"
                    // Navigation reads it: that message's top is not its start.
                    data-turn-message-cut={headRowSkip?.messageId}
                    style={{ height: hiddenHeadRows * ESTIMATED_ROW_HEIGHT_PX }}
                />
            ) : null}
            {visibleMessages.map((message) => (
                <ActivityRowSkipContext.Provider
                    key={message.info.id}
                    value={headRowSkip && message.info.id === headRowSkip.messageId ? headRowSkip : outerRowSkip}
                >
                    {renderMessage(message)}
                </ActivityRowSkipContext.Provider>
            ))}
            {hiddenTailRows > 0 ? (
                <div
                    ref={tailSpacerRef}
                    aria-hidden="true"
                    data-turn-message-spacer="tail"
                    style={{ height: hiddenTailRows * ESTIMATED_ROW_HEIGHT_PX }}
                />
            ) : null}
        </>
    );
}
