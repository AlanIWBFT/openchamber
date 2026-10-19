import { isInvisibleText } from '@/lib/invisibleText';
import { runningCommandParts } from '@/lib/opencode/exec-metadata';
import { getLastConversationRecord, type TextPart, type ToolPart } from '@/lib/opencode/model';
import { isExplorationPartDisplayReady, isShownInPlace, openChamberToolCall, renderedPage } from '@/lib/opencode/tools';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import { fenceUiBlocks } from '../../uiBlocks/taggedBlocks';
import { shouldHideExecFollowUp } from '../../message/unifiedExec';
import type { ChatMessageEntry, TurnRecord } from './types';
import { isToolRowShown, LIVE_ACTIVITY_VISIBLE_ROWS } from './activityRows';

export function getTurnsWithLaterAssistant(turns: readonly TurnRecord[]): Set<string> {
    const retired = new Set<string>();
    let hasLaterAssistant = false;
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];
        if (hasLaterAssistant) retired.add(turn.turnId);
        hasLaterAssistant ||= turn.assistantMessages.length > 0;
    }
    return retired;
}

export function getLiveFinalMessage(messages: readonly ChatMessageEntry[], hasLaterTurn = false): ChatMessageEntry | undefined {
    // Do not use projectTurnSummary's intermediate-text fallback. Compaction,
    // synthetic prompts, skill and shell records are their own message roles
    // in v2 and can trail the final answer, so the lookup skips them instead
    // of reading the last record.
    const last = getLastConversationRecord(messages);
    // A following turn moves this activity into history immediately, including
    // an optimistic prompt before the assistant responds. Preserve its prose
    // without changing finish; removing the prompt restores the live preview.
    if (hasLaterTurn) {
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index];
            if (message.info.role === 'assistant' && message.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))) return message;
        }
        return undefined;
    }
    return last?.info.role === 'assistant' && last.info.finish === 'stop'
        && last.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))
        ? last : undefined;
}

export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isSessionNoticePart(activity.part))
        || (showReasoning && activity.kind === 'reasoning')
    ));
}

export type ShownPart = ToolPart | TextPart;

const UI_BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})openui-lang[ \t]*$/m;

export const isSettledAsk = (part: ToolPart): boolean => (
    part.state.status !== 'running' && part.state.status !== 'pending'
    && openChamberToolCall(part.tool, part.state.input)?.awaitsAnswer === true
);

const continuesShownText = (part: ToolPart, previous: ShownPart | undefined): boolean => (
    previous !== undefined && isSettledAsk(part) && renderedPage(part.tool, part.state) !== null
    && (previous.type === 'text' || isSettledAsk(previous))
);

export function getShownPages(messages: readonly ChatMessageEntry[], finalMessage?: ChatMessageEntry): ShownPart[] {
    const shown: ShownPart[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === 'tool') {
                const inView = isShownInPlace(part.tool, part.state) && !isSettledAsk(part);
                if (inView || continuesShownText(part, shown.at(-1))) shown.push(part);
            } else if (part.type === 'text' && message !== finalMessage && UI_BLOCK_FENCE.test(fenceUiBlocks(part.text))) {
                shown.push(part);
            }
        }
    }
    return shown;
}

export function uiPageMessageId(turn: TurnRecord | undefined, expanded: boolean, messageId: string, partId: string): string {
    const final = turn ? getLiveFinalMessage(turn.assistantMessages) : undefined;
    return !expanded && turn && final && getShownPages(turn.assistantMessages, final).some((part) => part.id === partId && part.messageID === messageId)
        ? final.info.id
        : messageId;
}

/** Only project commands from eligible Activity rows; Script children follow their parent's visibility. */
export function getRunningCommandMessages(messages: readonly ChatMessageEntry[], hiddenRowIds?: ReadonlySet<string>): ChatMessageEntry[] {
    return messages.flatMap((message) => {
        const parts: ToolPart[] = [];
        for (const part of message.parts) {
            if (part.type !== 'tool' || (hiddenRowIds && !hiddenRowIds.has(part.id))) continue;
            parts.push(...runningCommandParts(part));
        }
        return parts.length ? [{ ...message, parts }] : [];
    });
}

/** Select seven native rows of a running turn, keeping Exploration whole and pinning the latest prose separately. */
export function projectLiveActivityPreview(turn: TurnRecord, showReasoning: boolean) {
    let pinnedText: { message: ChatMessageEntry; part: Extract<ChatMessageEntry['parts'][number], { type: 'text' }> } | undefined;
    for (const message of turn.assistantMessages) {
        if (message.info.role !== 'assistant') continue;
        for (const part of message.parts) {
            if (part.type === 'text' && !isInvisibleText(part.text)) pinnedText = { message, part };
        }
    }

    // Only the group's anchor needs a message body. That body renders the full
    // original group through its turn context, including calls in later messages.
    const explorationAnchors = new Map<string, string>();
    const visibleExplorations = new Set<string>();
    for (const group of turn.explorationGroups) {
        const first = group.parts[0];
        if (!first) continue;
        if (group.parts.some((activity) => isExplorationPartDisplayReady(activity.part))) visibleExplorations.add(first.id);
        for (const activity of group.parts) explorationAnchors.set(activity.id, first.id);
    }

    const rowIds: string[] = [];
    for (const message of turn.assistantMessages) {
        for (const part of message.parts) {
            if (part.type === 'text') {
                if (part === pinnedText?.part || isInvisibleText(part.text)) continue;
            } else if (part.type === 'reasoning') {
                if (!showReasoning || !part.text.trim()) continue;
            } else if (part.type === 'tool') {
                if (shouldHideExecFollowUp(part)) continue;
                if (isShownInPlace(part.tool, part.state)) continue;
                const anchor = explorationAnchors.get(part.id);
                if (anchor) {
                    if (anchor !== part.id || !visibleExplorations.has(anchor)) continue;
                } else if (!isToolRowShown(part)) {
                    continue;
                }
            } else {
                continue;
            }
            rowIds.push(part.id);
        }
    }

    const visibleIds = new Set(rowIds.slice(-LIVE_ACTIVITY_VISIBLE_ROWS));
    const messages: ChatMessageEntry[] = [];
    for (const message of turn.assistantMessages) {
        const parts = message.parts.filter((part) => visibleIds.has(part.id));
        if (parts.length > 0) {
            messages.push(parts.length === message.parts.length ? message : { ...message, parts });
        }
    }
    const hiddenRowIds = rowIds.slice(0, Math.max(0, rowIds.length - LIVE_ACTIVITY_VISIBLE_ROWS));
    return { messages, pinnedText, hiddenCount: hiddenRowIds.length, hiddenRowIds };
}

/** Part-level boundaries keep prose and calls following a page below it, even in the same message. */
export function splitLiveActivityAtPages(turn: TurnRecord) {
    const shownIds = new Set(getShownPages(turn.assistantMessages).map((part) => part.id));
    const segments: { id: string; messages: ChatMessageEntry[]; page?: ShownPart }[] = [];
    let segment: typeof segments[number] = { id: turn.turnId, messages: [] };
    for (const message of turn.assistantMessages) {
        let parts: ChatMessageEntry['parts'] = [];
        const flush = () => {
            if (parts.length) segment.messages.push({ ...message, parts });
            parts = [];
        };
        for (const part of message.parts) {
            if ((part.type !== 'tool' && part.type !== 'text') || !shownIds.has(part.id)) {
                parts.push(part);
                continue;
            }
            flush();
            segment.page = part;
            segments.push(segment);
            segment = { id: `${turn.turnId}:after-page:${part.id}`, messages: [] };
        }
        flush();
    }
    if (segment.messages.length) segments.push(segment);
    return segments;
}
