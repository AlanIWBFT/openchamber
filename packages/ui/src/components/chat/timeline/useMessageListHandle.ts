import React from 'react';
import type { LegendListRef } from '@legendapp/list/react';

import { pageRowIndex } from '../lib/turns/timelineRows';
import { isReasoningRevealTarget } from '../search/reasoningReveal';
import {
    captureMessageViewportAnchor,
    type MessageViewportAnchor,
    type ViewportAnchorAlignment,
} from '../lib/scroll/messageViewportAnchor';
import type { MessageListHandle, RenderRow } from './types';
import type { useTimelineRowIndexes } from './useTimelineRowIndexes';
import { useNavigationSettle } from './useNavigationSettle';

export const useMessageListHandle = (
    ref: React.ForwardedRef<MessageListHandle>,
    {
        sessionKey,
        listRef,
        rows,
        indexes,
        expandTurnActivity,
    }: {
        sessionKey: string;
        listRef: React.MutableRefObject<Pick<LegendListRef, 'scrollToIndex' | 'scrollToEnd' | 'getScrollableNode'> | null>;
        rows: RenderRow[];
        indexes: ReturnType<typeof useTimelineRowIndexes>;
        expandTurnActivity: (foldIds: string[]) => boolean;
    },
) => {
    const { messageIndexMap, turnIndexMap, rowIndexByKey, foldedAnchorByMessage, collapsibleTurnByMessageId, turnByAssistantMessageId } = indexes;

    const resolveScrollContainer = React.useCallback((): HTMLElement | null => {
        return listRef.current?.getScrollableNode() ?? null;
    }, [listRef]);

    const anchorRowIndex = React.useCallback((anchor: MessageViewportAnchor): number | undefined => {
        const folded = foldedAnchorByMessage.get(anchor.messageId);
        if (folded) {
            const first = messageIndexMap.get(folded.source);
            if (first !== undefined) return pageRowIndex(rows, first, folded.source, folded.part) ?? first;
        }
        return (anchor.slice ? rowIndexByKey.get(`step:${anchor.messageId}:${anchor.slice}`) : undefined)
            ?? messageIndexMap.get(anchor.messageId);
    }, [foldedAnchorByMessage, messageIndexMap, rowIndexByKey, rows]);

    const revealFoldedMessage = React.useCallback((messageId: string): boolean => {
        const turnId = isReasoningRevealTarget(messageId)
            ? turnByAssistantMessageId.get(messageId)
            : collapsibleTurnByMessageId.get(messageId);
        if (!turnId) return false;
        return expandTurnActivity(turnId);
    }, [collapsibleTurnByMessageId, expandTurnActivity, turnByAssistantMessageId]);

    const findMessageElement = React.useCallback((messageId: string): HTMLElement | null => {
        const container = resolveScrollContainer();
        if (!container) {
            return null;
        }
        if (isReasoningRevealTarget(messageId)) {
            const reasoning = container.querySelector<HTMLElement>(`[data-reasoning-message-id="${messageId}"]`);
            if (reasoning) return reasoning;
        }
        return container.querySelector(`[data-message-id="${messageId}"]:not([data-message-slice])`);
    }, [resolveScrollContainer]);

    const findAnchorElement = React.useCallback((anchor: MessageViewportAnchor): HTMLElement | null => {
        const folded = foldedAnchorByMessage.get(anchor.messageId);
        if (folded) return resolveScrollContainer()?.querySelector<HTMLElement>(`[data-tool-segment="${CSS.escape(folded.segmentId)}"]`) ?? null;
        return anchor.slice && rowIndexByKey.has(`step:${anchor.messageId}:${anchor.slice}`)
            ? resolveScrollContainer()?.querySelector<HTMLElement>(`[data-message-id="${anchor.messageId}"][data-message-slice="${anchor.slice}"]`) ?? null
            : findMessageElement(anchor.messageId);
    }, [findMessageElement, foldedAnchorByMessage, resolveScrollContainer, rowIndexByKey]);

    const anchorOffset = React.useCallback((anchor: MessageViewportAnchor) => (
        foldedAnchorByMessage.has(anchor.messageId) ? 0 : anchor.offsetTop
    ), [foldedAnchorByMessage]);

    const scrollHistoryIndexIntoView = React.useCallback((index: number) => {
        if (index < 0 || index >= rows.length) {
            return false;
        }

        const list = listRef.current;
        if (!list) {
            return false;
        }

        void list.scrollToIndex({ index, animated: false, viewPosition: 0 });
        return true;
    }, [listRef, rows.length]);

    const { cancelNavigationRef, settleNavigationTarget } = useNavigationSettle(sessionKey, resolveScrollContainer);
    const navigationRows = React.useRef({ rows, messageIndexMap, scrollHistoryIndexIntoView });

    const scrollMessageElementIntoView = React.useCallback((messageId: string, behavior: ScrollBehavior = 'auto') => {
        const container = resolveScrollContainer();
        if (!container) {
            return false;
        }
        const messageElement = findMessageElement(messageId);
        if (!messageElement) {
            return false;
        }

        const containerRect = container.getBoundingClientRect();
        const messageRect = messageElement.getBoundingClientRect();
        const offset = 50;
        const top = messageRect.top - containerRect.top + container.scrollTop - offset;
        container.scrollTo({ top, behavior });
        return true;
    }, [findMessageElement, resolveScrollContainer]);

    const alignViewportAnchor = React.useCallback((anchor: MessageViewportAnchor, revealFolded = false): ViewportAnchorAlignment => {
        const index = anchorRowIndex(anchor);
        const container = resolveScrollContainer();
        if (index === undefined || !container) {
            return 'missing';
        }
        if (revealFolded && revealFoldedMessage(anchor.messageId)) {
            scrollHistoryIndexIntoView(index);
            return 'moved';
        }

        const element = findAnchorElement(anchor);
        if (!element) {
            return scrollHistoryIndexIntoView(index) ? 'moved' : 'missing';
        }
        const delta = element.getBoundingClientRect().top
            - container.getBoundingClientRect().top
            - anchorOffset(anchor);
        if (Math.abs(delta) <= 0.5) {
            return 'aligned';
        }
        const before = container.scrollTop;
        container.scrollTop += delta;
        return Math.abs(container.scrollTop - before) < 0.5 ? 'aligned' : 'moved';
    }, [anchorOffset, anchorRowIndex, findAnchorElement, resolveScrollContainer, revealFoldedMessage, scrollHistoryIndexIntoView]);

    React.useLayoutEffect(() => {
        navigationRows.current = { rows, messageIndexMap, scrollHistoryIndexIntoView };
        if (!ref) {
            return;
        }

        const handle: MessageListHandle = {
            scrollToUiPageRow: (messageId, partId) => {
                const first = messageIndexMap.get(messageId);
                const index = first === undefined ? undefined : pageRowIndex(rows, first, messageId, partId);
                if (index === undefined) return false;
                cancelNavigationRef.current?.();
                return scrollHistoryIndexIntoView(index);
            },
            scrollToTurnId: (turnId: string, options?: { behavior?: ScrollBehavior }) => {
                cancelNavigationRef.current?.();
                const behavior = options?.behavior ?? 'auto';
                const index = turnIndexMap.get(turnId);
                if (index === undefined) {
                    return false;
                }

                const container = resolveScrollContainer();
                if (!container) {
                    return false;
                }
                const findTurnElement = () => container.querySelector<HTMLElement>(`[data-turn-id="${turnId}"]`);
                const turnElement = findTurnElement();
                if (turnElement) {
                    turnElement.scrollIntoView({ behavior, block: 'start' });
                    if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                    return true;
                }

                if (!scrollHistoryIndexIntoView(index)) {
                    return false;
                }
                if (behavior !== 'smooth') settleNavigationTarget(findTurnElement, 0);
                return true;
            },

            scrollToMessageId: (messageId: string, options?: { behavior?: ScrollBehavior }) => {
                cancelNavigationRef.current?.();
                const behavior = options?.behavior ?? 'auto';
                const index = messageIndexMap.get(messageId);
                if (index === undefined) {
                    return false;
                }

                if (revealFoldedMessage(messageId)) {
                    let requestedIndex: number | undefined;
                    settleNavigationTarget(() => {
                        const latest = navigationRows.current;
                        const target = latest.messageIndexMap.get(messageId);
                        if (target === undefined) return null;
                        const row = latest.rows[target];
                        if (row?.kind !== 'turn-message' || row.messageId !== messageId) return null;
                        const element = findMessageElement(messageId);
                        if (!element && target !== requestedIndex) {
                            latest.scrollHistoryIndexIntoView(target);
                            requestedIndex = target;
                        }
                        return element;
                    }, 50);
                    return true;
                }
                const didScroll = scrollMessageElementIntoView(messageId, behavior)
                    || scrollHistoryIndexIntoView(index);
                if (didScroll && behavior !== 'smooth') {
                    settleNavigationTarget(() => findMessageElement(messageId), 50);
                }
                return didScroll;
            },

            holdViewportAnchor: (anchor) => {
                settleNavigationTarget(() => findAnchorElement(anchor), anchorOffset(anchor));
            },

            isHistoryVirtualized: () => true,

            captureViewportAnchor: () => {
                const container = resolveScrollContainer();
                return container ? captureMessageViewportAnchor(container) : null;
            },

            restoreViewportAnchor: (anchor) => alignViewportAnchor(anchor) !== 'missing',

            alignViewportAnchor,

            hasMessageRow: (messageId) => messageIndexMap.has(messageId),

            scrollToBottom: () => {
                const list = listRef.current;
                if (list) {
                    void list.scrollToEnd({ animated: false });
                    return;
                }
                const container = resolveScrollContainer();
                if (!container) return;
                container.scrollTop = container.scrollHeight + 4096;
            },
        };

        if (typeof ref === 'function') {
            ref(handle);
            return () => {
                ref(null);
            };
        }

        const objectRef = ref;
        objectRef.current = handle;
        return () => {
            if (objectRef.current === handle) objectRef.current = null;
        };
    }, [alignViewportAnchor, anchorOffset, cancelNavigationRef, findAnchorElement, findMessageElement, listRef, messageIndexMap, resolveScrollContainer, revealFoldedMessage, rows, scrollHistoryIndexIntoView, scrollMessageElementIntoView, settleNavigationTarget, turnIndexMap, ref]);
};
