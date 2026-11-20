import { isHiddenUserMessage } from '../../message/hiddenUserMessage';
import { filterVisibleParts, isTranscriptPart } from '../../message/partUtils';
import { answerChunkCuts } from './answerChunks';
import { hiddenToolCount, hiddenToolRow, toolSegments } from './toolSegments';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';

type TurnEntry = Extract<TimelineEntry, { kind: 'turn' }>;
type UngroupedEntry = Extract<TimelineEntry, { kind: 'ungrouped' }>;

export type TextCut = { partId: string; offset: number };

export type MessageSlice = {
    from?: TextCut;
    to?: TextCut;
    index: number;
    count: number;
};

export type TimelineRow =
    | { kind: 'ungrouped'; key: string; entry: UngroupedEntry }
    | ({ kind: 'turn-head'; key: string } & TurnRowFields)
    | ({
        kind: 'turn-message';
        key: string;
        messageId: string;
        foldedHeader?: string;
        slice: MessageSlice | null;
    } & TurnRowFields);

type TurnRowFields = {
    entry: TurnEntry;
    ownsToolPreview: boolean;
    expandedSegments: ReadonlyMap<string, boolean>;
    gapBelow: boolean;
    expanded: boolean;
};

export type TimelineRowsOptions = {
    collapsedActivity: boolean;
    expandedTurns: ReadonlyMap<string, boolean>;
    showReasoningTraces: boolean;
    liveToolPresence?: { key: string; hasSegments: boolean };
};

const isMessageCompleted = (message: ChatMessageEntry): boolean => (
    message.info.role === 'assistant' && (message.info.time.completed ?? 0) > 0
);

const PARTS_PER_ROW = 24;

const messageCuts = (message: ChatMessageEntry, showReasoningTraces: boolean): TextCut[] => {
    const completed = isMessageCompleted(message);
    const cuts: TextCut[] = [];
    let partsInRow = 0;
    for (const part of filterVisibleParts(message.parts, { includeReasoning: showReasoningTraces })) {
        if (!isTranscriptPart(part)) continue;
        if (partsInRow === PARTS_PER_ROW) {
            cuts.push({ partId: part.id, offset: 0 });
            partsInRow = 0;
        }
        partsInRow += 1;
        if (!completed || part.type !== 'text' || part.time?.end === undefined) continue;
        const textCuts = answerChunkCuts(part.text);
        for (const offset of textCuts) cuts.push({ partId: part.id, offset });
        if (textCuts.length > 0) partsInRow = 1;
    }
    return cuts;
};

const sliceKey = (cut: TextCut) => `${cut.partId}:${cut.offset}`;
const noExpansion: ReadonlyMap<string, boolean> = new Map();

export function pageRowIndex(rows: TimelineRow[], first: number, messageId: string, partId: string): number | undefined {
    const head = rows[first];
    if (head?.kind !== 'turn-message' || head.messageId !== messageId) return undefined;
    const parts = head.entry.turn.assistantMessages.find(message => message.info.id === messageId)?.parts;
    const position = parts?.findIndex(part => part.id === partId) ?? -1;
    if (!parts || position < 0) return undefined;
    for (let i = first; i < rows.length; i++) {
        const row = rows[i];
        if (row.kind !== 'turn-message' || row.messageId !== messageId) break;
        const cut = row.slice?.to;
        if (!cut || parts.findIndex(part => part.id === cut.partId) > position) return i;
    }
}

const turnRows = (entry: TurnEntry, options: TimelineRowsOptions, ownsToolPreview: boolean): TimelineRow[] => {
    const { turn } = entry;
    const index = toolSegments(turn, options.showReasoningTraces);
    const preview = ownsToolPreview ? index.segments.at(-1) : undefined;
    const canFold = index.segments.some(segment => hiddenToolCount(segment, preview));
    const fields: TurnRowFields = { entry, ownsToolPreview, expandedSegments: canFold ? options.expandedTurns : noExpansion, gapBelow: false, expanded: canFold && !options.collapsedActivity };
    const rows: TimelineRow[] = [{ kind: 'turn-head', key: entry.key, ...fields }];
    const addMessage = (message: ChatMessageEntry) => {
        const messageId = message.info.id;
        const key = `step:${messageId}`;
        const cuts = messageCuts(message, options.showReasoningTraces);
        if (cuts.length === 0) {
            rows.push({ kind: 'turn-message', key, ...fields, messageId, slice: null });
            return;
        }
        cuts.forEach((cut, index) => {
            const from = index === 0 ? undefined : cuts[index - 1];
            rows.push({
                kind: 'turn-message',
                key: from ? `${key}:${sliceKey(from)}` : key,
                ...fields,
                messageId,
                slice: from ? { from, to: cut, index, count: cuts.length + 1 } : { to: cut, index, count: cuts.length + 1 },
            });
        });
        const last = cuts[cuts.length - 1];
        rows.push({ kind: 'turn-message', key: `${key}:${sliceKey(last)}`, ...fields, messageId, slice: { from: last, index: cuts.length, count: cuts.length + 1 } });
    };

    for (const message of turn.assistantMessages) {
        const notice = message.info.role === 'assistant' && (message.info.error || message.info.retry);
        if (!notice && !index.hasOtherContent.has(message.info.id) && index.byMessage.has(message.info.id) && message.parts.every(part => {
            const pos = index.byPart.get(part.id);
            return !pos || hiddenToolRow(part, pos, options.expandedTurns.get(pos.segment.id) ?? !options.collapsedActivity, preview);
        })) {
            const head = message.parts.find(part => index.byPart.has(part.id));
            const first = head && index.byPart.get(head.id);
            if (first?.index === 0) rows.push({
                kind: 'turn-message', key: `step:${message.info.id}`, messageId: message.info.id,
                ...fields, foldedHeader: first.segment.id, slice: null,
            });
            continue;
        }
        addMessage(message);
    }

    const last = rows[rows.length - 1];
    if (last.kind !== 'ungrouped' && !isHiddenUserMessage(entry.nextEntryFirstMessage)) rows[rows.length - 1] = { ...last, gapBelow: true };
    return rows;
};

const isSameSlice = (previous: MessageSlice | null, next: MessageSlice | null): boolean => (
    previous?.from?.partId === next?.from?.partId && previous?.from?.offset === next?.from?.offset
    && previous?.to?.partId === next?.to?.partId && previous?.to?.offset === next?.to?.offset
    && previous?.count === next?.count
);

const isSameRow = (previous: TimelineRow, next: TimelineRow): boolean => {
    if (previous.kind !== next.kind || previous.entry !== next.entry) return false;
    if (previous.kind === 'ungrouped' || next.kind === 'ungrouped') return true;
    if (previous.ownsToolPreview !== next.ownsToolPreview || previous.gapBelow !== next.gapBelow || previous.expanded !== next.expanded || previous.expandedSegments !== next.expandedSegments) return false;
    if (previous.kind === 'turn-message' && next.kind === 'turn-message') {
        return previous.messageId === next.messageId && previous.foldedHeader === next.foldedHeader && isSameSlice(previous.slice, next.slice);
    }
    return true;
};

export const buildTimelineRows = (
    entries: readonly TimelineEntry[],
    options: TimelineRowsOptions,
    previous: TimelineRow[],
): TimelineRow[] => {
    const previousByKey = new Map<string, TimelineRow>();
    for (const row of previous) previousByKey.set(row.key, row);
    const rows: TimelineRow[] = [];
    let previewOwner: TurnEntry | undefined;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry.kind !== 'turn') continue;
        const live = options.liveToolPresence;
        if (live && live.key === entry.key ? live.hasSegments : toolSegments(entry.turn, options.showReasoningTraces).segments.length > 0) {
            previewOwner = entry;
            break;
        }
    }
    for (const entry of entries) {
        const built: TimelineRow[] = entry.kind === 'turn' ? turnRows(entry, options, entry === previewOwner) : [{ kind: 'ungrouped', key: entry.key, entry }];
        for (const row of built) {
            const reusable = previousByKey.get(row.key);
            rows.push(reusable && isSameRow(reusable, row) ? reusable : row);
        }
    }
    const unchanged = rows.length === previous.length && rows.every((row, index) => row === previous[index]);
    return unchanged ? previous : rows;
};
