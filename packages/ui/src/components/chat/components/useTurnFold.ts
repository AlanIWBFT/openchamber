import React from 'react';
import { getShownPages, projectFoldMessages } from '../lib/turns/liveActivity';
import type { TurnRecord } from '../lib/turns/types';

export const foldContentId = (turnId: string) => `turn-activity-${turnId}`;
export const finalActivityContentId = (turnId: string) => `turn-final-activity-${turnId}`;

/**
 * A turn's foldable work in either default mode, as list rows split it
 * (`timelineRows.ts`): the fold's header row, the steps (rows of their own
 * once opened), the pages a turn without an answer showed, and the final
 * answer, whose own non-text parts fold with the rest.
 */
export const useTurnFold = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined) => {
    const { finalMessage, activityMessages } = React.useMemo(() => projectFoldMessages(turn, finalMessageId), [turn, finalMessageId]);
    const settled = Boolean(finalMessage) || hasLaterAssistant;
    const pages = React.useMemo(() => getShownPages(turn.assistantMessages, turn.assistantMessages.find((message) => message.info.id === finalMessageId)), [turn.assistantMessages, finalMessageId]);
    return { finalMessage, activityMessages, settled, isExpanded: !settled || expanded, pages };
};

export const useTurnFoldContexts = (turn: TurnRecord, hasLaterAssistant: boolean, expanded: boolean, finalMessageId: string | undefined) => {
    const { finalMessage, isExpanded, pages } = useTurnFold(turn, hasLaterAssistant, expanded, finalMessageId);
    const hoistedPages = React.useMemo(() => new Set(pages.map((part) => part.id)), [pages]);
    const shownFinalMessageId = finalMessage?.info.id;
    const finalContext = React.useMemo(() => shownFinalMessageId ? {
        messageId: shownFinalMessageId, expanded: isExpanded, contentId: finalActivityContentId(turn.turnId), pages,
    } : null, [shownFinalMessageId, isExpanded, pages, turn.turnId]);
    return { hoistedPages, finalContext };
};
