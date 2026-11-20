import { isInvisibleText } from '@/lib/invisibleText';
import { runningCommandParts } from '@/lib/opencode/exec-metadata';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import { isExplorationPartDisplayReady } from '@/lib/opencode/exploration';
import { isShownInPlace } from '@/lib/opencode/tools';
import type { Part } from '@/lib/opencode/model';
import { shouldHideExecFollowUp } from '../../message/unifiedExec';
import { isToolRowShown } from './activityRows';
import { summarizeActivityGroups, type LiveActivitySummary } from './liveActivitySummary';
import type { TurnRecord } from './types';

export interface ToolSegment {
    id: string;
    rows: Part[];
    collapsibleRows: number;
    hiddenBeforePreview: number;
    readonly summary: LiveActivitySummary;
}

// Every virtual row of the same immutable turn uses the same segment boundaries.
const indexes = [new WeakMap<TurnRecord, ReturnType<typeof indexSegments>>(), new WeakMap<TurnRecord, ReturnType<typeof indexSegments>>()];
export function toolSegments(turn: TurnRecord, reasoning: boolean) {
    const cache = indexes[Number(reasoning)];
    const existing = cache.get(turn);
    if (existing) return existing;
    const index = indexSegments(turn, reasoning);
    cache.set(turn, index);
    return index;
}

function indexSegments(turn: TurnRecord, reasoning: boolean) {
    const segments: ToolSegment[] = [];
    const byPart = new Map<string, { segment: ToolSegment; index: number }>();
    const byMessage = new Map<string, Set<string>>();
    const hasOtherContent = new Set<string>();
    const suppressed = new Set<string>();
    const explorationByHead = new Map<string, typeof turn.explorationGroups[number]['parts']>();
    for (const group of turn.explorationGroups) {
        const ready = group.parts.some(item => isExplorationPartDisplayReady(item.part));
        if (ready && group.parts[0]) {
            explorationByHead.set(group.parts[0].id, group.parts);
        }
        for (const [index, item] of group.parts.entries()) if (index || !ready) suppressed.add(item.id);
    }
    let segment: ToolSegment | undefined;
    let hasAnswerText = false;
    for (const message of turn.assistantMessages) {
        for (const part of message.parts) {
            if (part.type === 'text') {
                if (!isInvisibleText(part.text)) {
                    hasAnswerText = true;
                    hasOtherContent.add(message.info.id);
                    segment = undefined;
                }
                continue;
            }
            if (part.type === 'tool') {
                if (isShownInPlace(part.tool, part.state) || isSessionNoticePart(part)) {
                    hasOtherContent.add(message.info.id);
                    segment = undefined;
                    continue;
                }
                if (!isToolRowShown(part) || shouldHideExecFollowUp(part) || suppressed.has(part.id)) continue;
            } else if (part.type !== 'reasoning') {
                if (part.type === 'file') hasOtherContent.add(message.info.id);
                continue;
            } else if (!reasoning || isInvisibleText(part.text)) {
                if (reasoning && part.time?.end === undefined) hasOtherContent.add(message.info.id);
                continue;
            }
            if (!segment) {
                const rows: Part[] = [];
                let summary: LiveActivitySummary | undefined;
                segment = { id: `${turn.turnId}:work:${part.id}`, rows, collapsibleRows: 0, hiddenBeforePreview: 0,
                    get summary() {
                        // An Exploration is one preview row, but its report covers all the calls behind it.
                        return summary ??= summarizeActivityGroups(rows.flatMap(row => explorationByHead.get(row.id)?.map(
                            member => [member.messageId, [member.part]] as const,
                        ) ?? [[row.messageID, [row]] as const]));
                    },
                };
                segments.push(segment);
            }
            byPart.set(part.id, { segment, index: segment.rows.length });
            segment.rows.push(part);
            let ids = byMessage.get(message.info.id);
            if (!ids) byMessage.set(message.info.id, ids = new Set());
            ids.add(segment.id);
        }
    }
    segments.forEach(item => {
        item.rows.forEach((part, index) => {
            if (part.type === 'tool' && runningCommandParts(part).length) return;
            item.collapsibleRows++;
            if (index < item.rows.length - PREVIEW_ROWS) item.hiddenBeforePreview++;
        });
    });
    return { segments, byPart, byMessage, hasOtherContent, hasAnswerText };
}

const PREVIEW_ROWS = 7;

export function hiddenToolCount(segment: ToolSegment, preview: ToolSegment | undefined) {
    return segment === preview ? segment.hiddenBeforePreview : segment.collapsibleRows;
}

export function hiddenToolRow(part: Part, position: { segment: ToolSegment; index: number }, expanded: boolean, preview: ToolSegment | undefined) {
    if (expanded || (position.segment === preview && position.index >= position.segment.rows.length - PREVIEW_ROWS)) return false;
    return part.type !== 'tool' || runningCommandParts(part).length === 0;
}
