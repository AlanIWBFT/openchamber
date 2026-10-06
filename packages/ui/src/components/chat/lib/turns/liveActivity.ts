import { getLastConversationRecord, type ToolPart } from '@/lib/opencode/model';
import { isExplorationPartDisplayReady, renderedPage } from '@/lib/opencode/tools';
import { shouldHideExecFollowUp } from '../../message/unifiedExec';
import type { ChatMessageEntry, TurnRecord } from './types';
import { isToolRowShown, LIVE_ACTIVITY_VISIBLE_ROWS } from './activityRows';

/** A queued user message alone does not retire the previous turn. */
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

export function getLiveFinalMessage(messages: readonly ChatMessageEntry[]): ChatMessageEntry | undefined {
    // Do not use projectTurnSummary's intermediate-text fallback. Compaction,
    // synthetic prompts, skill and shell records are their own message roles
    // in v2 and can trail the final answer, so the lookup skips them instead
    // of reading the last record.
    const last = getLastConversationRecord(messages);
    return last?.info.role === 'assistant' && last.info.finish === 'stop'
        && last.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
        ? last : undefined;
}

export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.hasTools || (showReasoning && turn.hasReasoning);
}

/** Select seven native rows of a running turn, keeping Exploration whole and pinning the latest prose separately. */
export function projectLiveActivityPreview(turn: TurnRecord, showReasoning: boolean) {
    let pinnedText: { message: ChatMessageEntry; part: Extract<ChatMessageEntry['parts'][number], { type: 'text' }> } | undefined;
    for (const message of turn.assistantMessages) {
        if (message.info.role !== 'assistant') continue;
        for (const part of message.parts) {
            if (part.type === 'text' && part.text.trim()) pinnedText = { message, part };
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
                if (part === pinnedText?.part || !part.text.trim()) continue;
            } else if (part.type === 'reasoning') {
                if (!showReasoning || !part.text.trim()) continue;
            } else if (part.type === 'tool') {
                if (shouldHideExecFollowUp(part)) continue;
                if (renderedPage(part.tool, part.state)) continue;
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
    return { messages, pinnedText, hiddenCount: Math.max(0, rowIds.length - LIVE_ACTIVITY_VISIBLE_ROWS) };
}

/** The pages a turn's `openchamber_render` calls showed, waiting ones included, in the order they ran. */
export function getShownPages(messages: readonly ChatMessageEntry[]): ToolPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => (
        part.type === 'tool' && renderedPage(part.tool, part.state) !== null
    )));
}

/** Part-level boundaries keep prose and calls following a page below it, even in the same message. */
export function splitLiveActivityAtPages(turn: TurnRecord) {
    const segments: { id: string; messages: ChatMessageEntry[]; page?: ToolPart }[] = [];
    let segment: typeof segments[number] = { id: turn.turnId, messages: [] };
    for (const message of turn.assistantMessages) {
        let parts: ChatMessageEntry['parts'] = [];
        const flush = () => {
            if (parts.length) segment.messages.push({ ...message, parts });
            parts = [];
        };
        for (const part of message.parts) {
            if (part.type !== 'tool' || !renderedPage(part.tool, part.state)) {
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
