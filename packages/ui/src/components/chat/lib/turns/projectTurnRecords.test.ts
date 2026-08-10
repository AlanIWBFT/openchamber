import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

function createMessageEntry({
    id,
    role,
    parentID,
    createdAt,
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    parentID?: string;
    createdAt: number;
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            ...(parentID ? { parentID } : {}),
            time: { created: createdAt },
        } as Message,
        parts: [] as Part[],
    };
}

describe('projectTurnRecords', () => {
    test('groups exploration tools across adjacent assistant messages', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [{ id: 'grep-1', type: 'tool', tool: 'grep', state: { status: 'completed' } }] as unknown as Part[],
        };
        const assistant2 = {
            ...createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 3 }),
            parts: [{ id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed' } }] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant1, assistant2]);

        expect(projection.turns[0]?.explorationGroups).toHaveLength(1);
        expect(projection.turns[0]?.explorationGroups[0]?.anchorMessageId).toBe('a1');
        expect(projection.turns[0]?.explorationGroups[0]?.parts.map((part) => part.id)).toEqual(['grep-1', 'read-1']);
    });

    test('splits exploration groups at visible text', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'grep-1', type: 'tool', tool: 'grep', state: { status: 'completed' } },
                { id: 'text-1', type: 'text', text: 'Checking the result.' },
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['grep-1'], ['read-1']]);
    });

    test('uses reasoning visibility as an exploration boundary', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'glob-1', type: 'tool', tool: 'glob', state: { status: 'completed' } },
                { id: 'reasoning-1', type: 'reasoning', text: 'Inspecting candidates.' },
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        const visible = projectTurnRecords([user, assistant], { showReasoningTraces: true });
        const hidden = projectTurnRecords([user, assistant], { showReasoningTraces: false });

        expect(visible.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['glob-1'], ['read-1']]);
        expect(hidden.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['glob-1', 'read-1']]);
    });

    test('does not classify namespaced custom tools as exploration tools', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read:0', state: { status: 'completed' } },
                { id: 'custom-read', type: 'tool', tool: 'plugin.read', state: { status: 'completed' } },
                { id: 'grep-1', type: 'tool', tool: 'grep', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['read-1'], ['grep-1']]);
    });

    test('keeps exploration activity segmented around indexed task tools', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'running' } },
                { id: 'task-1', type: 'tool', tool: 'task:0', state: { status: 'running' } },
                { id: 'grep-1', type: 'tool', tool: 'grep', state: { status: 'running' } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.activitySegments.map((segment) => ({
            afterToolPartId: segment.afterToolPartId,
            partIds: segment.parts.map((part) => part.id),
        }))).toEqual([
            { afterToolPartId: null, partIds: ['read-1'] },
            { afterToolPartId: 'task-1', partIds: ['grep-1'] },
        ]);
        expect(projection.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['read-1'], ['grep-1']]);
    });

    test('keeps the first exploration identity stable while appending and splitting the tail', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const initialAssistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'read-1', type: 'tool', tool: 'read', state: { status: 'running' } },
            ] as unknown as Part[],
        };
        const appendedAssistant = {
            ...initialAssistant,
            parts: [
                ...initialAssistant.parts,
                { id: 'grep-1', type: 'tool', tool: 'grep', state: { status: 'running' } } as unknown as Part,
            ],
        };
        const splitAssistant = {
            ...appendedAssistant,
            parts: [
                ...appendedAssistant.parts,
                { id: 'text-1', type: 'text', text: 'Now inspect a specific file.' } as unknown as Part,
                { id: 'read-2', type: 'tool', tool: 'read', state: { status: 'running' } } as unknown as Part,
            ],
        };

        const initial = projectTurnRecords([user, initialAssistant]);
        const appended = projectTurnRecords([user, appendedAssistant]);
        const split = projectTurnRecords([user, splitAssistant]);

        expect(appended.turns[0]?.explorationGroups[0]?.id).toBe(initial.turns[0]?.explorationGroups[0]?.id);
        expect(split.turns[0]?.explorationGroups.map((group) => ({ id: group.id, parts: group.parts.map((part) => part.id) })))
            .toEqual([
                { id: 'u1:exploration:read-1', parts: ['read-1', 'grep-1'] },
                { id: 'u1:exploration:read-2', parts: ['read-2'] },
            ]);
    });

    test('projects large exploration sequences with deterministic text boundaries', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const parts = Array.from({ length: 1_000 }, (_, index) => {
            const tool = {
                id: `tool-${index}`,
                type: 'tool',
                tool: index % 2 === 0 ? 'grep' : 'read',
                state: { status: 'running' },
            } as unknown as Part;
            if (index === 0 || index % 50 !== 0) return [tool];
            return [
                { id: `text-${index}`, type: 'text', text: `Boundary ${index}` } as unknown as Part,
                tool,
            ];
        }).flat();
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts,
        };

        const projection = projectTurnRecords([user, assistant]);
        const groups = projection.turns[0]?.explorationGroups ?? [];

        expect(groups).toHaveLength(20);
        expect(groups.every((group) => group.parts.length === 50)).toBe(true);
        expect(groups.reduce((total, group) => total + group.parts.length, 0)).toBe(1_000);
    });

    test('groups assistant replies under their parent user turn', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('keeps out-of-order assistant replies attached to their parent user turn', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });

        const projection = projectTurnRecords([user1, assistant1, assistant2, user2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.turns[1]?.turnId).toBe('u2');
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('does not render assistant replies while their parent user turn is missing', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, assistant2]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.has('a2')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a2')).toBe(false);
    });

    test('does not render orphan assistant messages as standalone ungrouped entries', () => {
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'missing-user', createdAt: 1 });

        const projection = projectTurnRecords([assistant]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
    });

    test('keeps non-assistant orphan messages available as ungrouped entries', () => {
        const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

        const projection = projectTurnRecords([system]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
    });

    test('reuses unchanged turn records from the previous projection', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const initial = projectTurnRecords([user1, assistant1, user2, assistant2]);
        const updatedAssistant2 = {
            ...assistant2,
            parts: [{ type: 'text', text: 'stream update' } as Part],
        };

        const next = projectTurnRecords([user1, assistant1, user2, updatedAssistant2], {
            previousProjection: initial,
        });

        expect(next.turns[0]).toBe(initial.turns[0]);
        expect(next.turns[1]).not.toBe(initial.turns[1]);
    });

    test('hydrates updated turns when a previous projection exists but no turn is reusable', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);
        const updatedAssistant = {
            ...assistant,
            parts: [{ id: 'tool_1', type: 'tool', tool: 'bash', state: { status: 'completed' } } as Part],
        };

        const next = projectTurnRecords([user, updatedAssistant], {
            previousProjection: initial,
        });

        expect(next.turns).toHaveLength(1);
        expect(next.turns[0]).not.toBe(initial.turns[0]);
        expect(next.turns[0]?.hasTools).toBe(true);
        expect(next.turns[0]?.activityParts).toHaveLength(1);
        expect(next.turns[0]?.stream.isStreaming).toBe(true);
        expect(next.turns[0]?.stream.isRetrying).toBe(false);
    });

    test('omits successful exec follow-ups from Activity without hiding failures', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'exec-1', type: 'tool', tool: 'exec_command', state: { status: 'completed', metadata: { processRunning: true } } },
                { id: 'poll-1', type: 'tool', tool: 'poll_exec', state: { status: 'completed', metadata: { execDisplay: 'poll' } } },
                { id: 'terminate-1', type: 'tool', tool: 'terminate_exec', state: { status: 'completed', metadata: { execError: 'not found' } } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(true);
        expect(projection.turns[0]?.activityParts.map((record) => record.id)).toEqual(['exec-1', 'terminate-1']);
        expect(projection.turns[0]?.activitySegments.flatMap((group) => group.parts.map((record) => record.id)))
            .toEqual(['exec-1', 'terminate-1']);
    });

    test('does not create tool Activity for a message containing only successful exec follow-ups', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'poll-1', type: 'tool', tool: 'poll_exec', state: { status: 'completed', metadata: { execDisplay: 'poll' } } },
                { id: 'terminate-1', type: 'tool', tool: 'terminate_exec', state: { status: 'completed', metadata: { execDisplay: 'terminate' } } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(false);
        expect(projection.turns[0]?.activityParts).toEqual([]);
        expect(projection.turns[0]?.activitySegments).toEqual([]);
    });

    test('does not create tool Activity for todo updates', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'completed' } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(false);
        expect(projection.turns[0]?.activityParts).toEqual([]);
        expect(projection.turns[0]?.activitySegments).toEqual([]);
    });

    test('keeps failed todo updates in Activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 }),
            parts: [
                { id: 'todo-1', type: 'tool', tool: 'todowrite', state: { status: 'error', error: 'Todo update failed' } },
            ] as unknown as Part[],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(true);
        expect(projection.turns[0]?.activityParts.map((record) => record.id)).toEqual(['todo-1']);
        expect(projection.turns[0]?.activitySegments.flatMap((group) => group.parts.map((record) => record.id)))
            .toEqual(['todo-1']);
    });

    test('reuses the whole turns array when every turn is unchanged', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const initial = projectTurnRecords([user, assistant]);

        const next = projectTurnRecords([user, assistant], {
            previousProjection: initial,
        });

        expect(next.turns).toBe(initial.turns);
        expect(next.turns[0]).toBe(initial.turns[0]);
    });

    test('merges turns started by hidden user messages when merging is enabled', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user1.parts = [{ id: 'p1', type: 'text', text: 'visible prompt' } as Part];
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2']);
        expect(projection.ungroupedMessageIds.has('u2')).toBe(false);
    });

    test('keeps hidden user messages as separate turns when merging is disabled', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[1]?.turnId).toBe('u2');
    });

    test('does not merge a hidden user message when there is no previous turn', () => {
        const hiddenUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });

        const projection = projectTurnRecords([hiddenUser, assistant], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    });

    test('chains merges across consecutive hidden user messages', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user1.parts = [{ id: 'p1', type: 'text', text: 'visible prompt' } as Part];
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        const hidden1 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u2', createdAt: 4 });
        const hidden2 = createMessageEntry({ id: 'u3', role: 'user', createdAt: 5 });
        const assistant3 = createMessageEntry({ id: 'a3', role: 'assistant', parentID: 'u3', createdAt: 6 });

        const projection = projectTurnRecords([user1, assistant1, hidden1, assistant2, hidden2, assistant3], {
            mergeHiddenUserTurns: { planModeEnabled: false },
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2', 'a3']);
    });

    test('treats compaction summary text as justification activity in sorted mode', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user.parts = [{ id: 'p1', type: 'text', text: 'prompt' } as Part];
        const compaction = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        (compaction.info as { summary?: boolean; finish?: string }).summary = true;
        (compaction.info as { summary?: boolean; finish?: string }).finish = 'stop';
        compaction.parts = [{ id: 'cp1', type: 'text', text: 'compacted context summary' } as Part];
        const assistant = createMessageEntry({ id: 'a2', role: 'assistant', parentID: 'u1', createdAt: 3 });
        (assistant.info as { finish?: string }).finish = 'stop';
        assistant.parts = [{ id: 'ap1', type: 'text', text: 'final answer' } as Part];

        const projection = projectTurnRecords([user, compaction, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn?.summaryText).toBe('final answer');
        const compactionActivity = turn?.activityParts.find((activity) => activity.messageId === 'a1');
        expect(compactionActivity?.kind).toBe('justification');
        const finalActivity = turn?.activityParts.find((activity) => activity.messageId === 'a2');
        expect(finalActivity).toBe(undefined);
    });

    test('keeps text inline (not justification) when a message is blocked on a pending question', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user.parts = [{ id: 'p1', type: 'text', text: 'prompt' } as Part];
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', parentID: 'u1', createdAt: 2 });
        // The turn is blocked waiting for the user's answer: no finish and a
        // pending question tool part, with context text before the question.
        assistant.parts = [
            { id: 'ap1', type: 'text', text: 'context before the question' } as Part,
            {
                id: 'ap2',
                type: 'tool',
                callID: 'c1',
                tool: 'question',
                state: { status: 'pending' },
            } as Part,
        ];

        const projection = projectTurnRecords([user, assistant], {
            showTextJustificationActivity: true,
        });

        const turn = projection.turns[0];
        expect(turn).toBeDefined();
        const textActivity = turn?.activityParts.find((activity) => activity.partIndex === 0);
        expect(textActivity?.kind).not.toBe('justification');
        // The question tool itself still participates in the activity group.
        const questionActivity = turn?.activityParts.find((activity) => activity.partIndex === 1);
        expect(questionActivity?.kind).toBe('tool');
    });
});
