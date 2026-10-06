import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@/lib/opencode/model';

import { activityRowParts, isToolRowShown } from './activityRows';

const text = (id: string, value: string): Part => ({ id, messageID: 'm', sessionID: 's', type: 'text', text: value });

const tool = (id: string, state: ToolPart['state']): ToolPart => ({
    id, callID: id, type: 'tool', tool: 'read', messageID: 'm', sessionID: 's', state,
});

describe('isToolRowShown', () => {
    test('shows pending, running and settled calls with valid timing', () => {
        const parts: ToolPart[] = [
            tool('running', { status: 'running', input: {}, time: { start: 1 } }),
            tool('done', { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 1, end: 2 } }),
            tool('pending', { status: 'pending', input: {}, raw: '' }),
            tool('incomplete', { status: 'completed', input: {}, output: '', time: { start: 2, end: 1 } }),
        ];
        expect(parts.filter(isToolRowShown).map((part) => part.id)).toEqual(['running', 'done', 'pending']);
    });

    test('skips text made only of zero-width characters and keeps text that uses them', () => {
        const parts: Part[] = [
            text('zwsp', '\u200B'),
            text('bom', '\uFEFF\n'),
            text('joiners', '\u200C\u200D'),
            text('emoji', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'),
            text('persian', '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'),
        ];
        expect(activityRowParts(parts, true).map((part) => part.id)).toEqual(['emoji', 'persian']);
    });
});
