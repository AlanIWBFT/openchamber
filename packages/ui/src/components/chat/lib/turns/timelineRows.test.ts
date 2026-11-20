import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, TextPart, ToolPart } from '@/lib/opencode/model';
import { answerChunkCuts } from './answerChunks';
import { projectTurnRecords } from './projectTurnRecords';
import { hiddenToolRow, toolSegments } from './toolSegments';
import { buildTimelineRows, pageRowIndex, type TimelineRowsOptions } from './timelineRows';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';

const paragraph = (index: number) => `Paragraph ${index} explains one more step of the call sequence in plain words, long enough to wrap.\n\n`;
const longAnswer = Array.from({ length: 60 }, (_, index) => paragraph(index)).join('');

const textPart = (id: string, text: string, ended = true): Part => {
    const part: TextPart = { type: 'text', id, text, sessionID: 'session', messageID: 'message' };
    if (ended) part.time = { start: 1, end: 2 };
    return part;
};
const readPart: ToolPart = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'step',
    state: { status: 'completed', input: { filePath: '/project/a.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};

const assistant = (id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry => {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
};

const turnEntry = (messages: ChatMessageEntry[]): TimelineEntry => {
    const turn = projectTurnRecords([
        { info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [textPart('prompt', 'Explain')] },
        ...messages,
    ]).turns[0]!;
    return { kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: true };
};

const summary: TimelineRowsOptions = { collapsedActivity: false, expandedTurns: new Map(), showReasoningTraces: true };
const collapsed: TimelineRowsOptions = { collapsedActivity: true, expandedTurns: new Map(), showReasoningTraces: true };

test('a page quote targets its own source slice after a long answer', () => {
    const page = { ...readPart, id: 'page', tool: 'openchamber_render' } as const;
    const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('prose', longAnswer), page], 'stop')])], collapsed, []);
    expect(rows.length).toBeGreaterThan(3);
    expect(pageRowIndex(rows, 1, 'answer', 'page')).toBe(rows.length - 1);
    expect(pageRowIndex(rows, 1, 'answer', 'missing')).toBeUndefined();
});

test('only the newest segment previews work; older singletons fold and running commands stay visible', () => {
    const cmd = (id: string, running = false): ToolPart => ({
        ...readPart, id, callID: id, tool: 'exec_command',
        state: { status: 'completed', input: { cmd: id }, output: '', metadata: { execDisplay: 'root', processRunning: running }, time: { start: 1, end: 2 } },
    });
    const parts = [cmd('only'), textPart('a', 'First'), cmd('live', true), cmd('done'), textPart('b', 'Second')];
    const visible = (parts: Part[]) => {
        const entry = turnEntry([assistant('step', parts)]);
        if (entry.kind !== 'turn') throw Error('Expected a turn');
        const index = toolSegments(entry.turn, true);
        return [...index.byPart].filter(([, pos]) => !hiddenToolRow(pos.segment.rows[pos.index], pos, false, index.segments.at(-1))).map(([id]) => id);
    };
    expect(visible(parts)).toEqual(['live', 'done']);
    expect(visible([...parts, cmd('third'), textPart('c', 'Third'), cmd('latest')])).toEqual(['live', 'latest']);
});

describe('answerChunkCuts', () => {
    test('leaves a short text whole', () => {
        expect(answerChunkCuts(paragraph(1).repeat(10))).toEqual([]);
    });

    test('cuts a long text only where a paragraph starts, into pieces that join back', () => {
        const cuts = answerChunkCuts(longAnswer);
        expect(cuts.length).toBeGreaterThan(1);
        for (const cut of cuts) expect(longAnswer.slice(cut).startsWith('Paragraph ')).toBe(true);
        const pieces = [0, ...cuts].map((start, index) => longAnswer.slice(start, cuts[index]));
        expect(pieces.join('')).toBe(longAnswer);
    });

    test('never starts a piece at a list, a code block or a table', () => {
        const text = Array.from({ length: 40 }, (_, index) => `${paragraph(index)}- item ${index}\n- next\n\n\`\`\`ts\nconst a = ${index};\n\`\`\`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`).join('');
        const cuts = answerChunkCuts(text);
        expect(cuts.length).toBeGreaterThan(0);
        for (const cut of cuts) expect(text.slice(cut).startsWith('Paragraph ')).toBe(true);
    });

    test('leaves a text with footnotes or link definitions whole', () => {
        expect(answerChunkCuts(`${longAnswer}[^1]: The note.\n`)).toEqual([]);
        expect(answerChunkCuts(`${longAnswer}[docs]: https://example.com\n`)).toEqual([]);
    });
});

describe('buildTimelineRows', () => {
    test('keeps an interrupted step after another segment takes its preview', () => {
        const cmd = (id: string): ToolPart => ({ ...readPart, id, messageID: id, tool: 'exec_command' });
        const interrupted = assistant('two', [cmd('two')], 'stop');
        if (interrupted.info.role !== 'assistant') throw Error('Expected assistant');
        interrupted.info.error = { type: 'SessionAborted', message: 'Stopped by user' };
        const entry = turnEntry([assistant('one', [cmd('one')]), interrupted, assistant('three', [textPart('t', 'Next'), cmd('three')])]);
        expect(buildTimelineRows([entry], collapsed, []).map(row => row.key)).toContain('step:two');
    });
    test('draws a turn as its prompt row and a row per step', () => {
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [readPart, textPart('note', 'Reading')], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ])], summary, []);
        expect(rows.map(row => row.key)).toEqual(['turn:user', 'step:step', 'step:answer']);
    });

    test('cuts a finished long answer into rows that name their slice', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer)], 'stop')])], summary, []);
        const cuts = answerChunkCuts(longAnswer);
        expect(rows.map((row) => row.key)).toEqual([
            'turn:user', 'step:answer', ...cuts.map((cut) => `step:answer:final:${cut}`),
        ]);
        const slices = rows.flatMap((row) => (row.kind === 'turn-message' ? [row.slice] : []));
        expect(slices[0]).toEqual({ to: { partId: 'final', offset: cuts[0] }, index: 0, count: cuts.length + 1 });
        expect(slices.at(-1)).toEqual({ from: { partId: 'final', offset: cuts.at(-1)! }, index: cuts.length, count: cuts.length + 1 });
    });

    test('cuts a step that ran dozens of calls into rows of parts, while it still runs', () => {
        const calls: Part[] = Array.from({ length: 30 }, (_, index) => ({ ...readPart, id: `read-${index}`, callID: `read-${index}` }));
        const rows = buildTimelineRows([turnEntry([assistant('step', calls)])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:step:read-24:0']);
        expect(rows[1]?.kind === 'turn-message' && rows[1].slice).toEqual({ to: { partId: 'read-24', offset: 0 }, index: 0, count: 2 });
    });

    test('keeps an answer still being written in one row', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer, false)])])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:answer']);
    });

    test('singleton work stays at its original position in either default mode', () => {
        const entry = turnEntry([
            assistant('step', [readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ]);
        const rows = buildTimelineRows([entry], collapsed, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:answer']);

        const opened = buildTimelineRows([entry], { ...collapsed, expandedTurns: new Map([['user', true]]) }, []);
        expect(opened.map((row) => row.key)).toEqual(rows.map(row => row.key));
    });

    test('keeps the row objects that did not change', () => {
        const entry = turnEntry([assistant('answer', [textPart('final', 'Done')], 'stop')]);
        const first = buildTimelineRows([entry], summary, []);
        expect(buildTimelineRows([entry], summary, first)).toBe(first);
        const opened = buildTimelineRows([entry], { ...summary, collapsedActivity: true }, first);
        expect(opened[0]).toBe(first[0]);
    });
});
