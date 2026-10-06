import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@/lib/opencode/model';

import { isToolRowShown } from './activityRows';

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
});
