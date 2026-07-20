import { describe, expect, test } from 'bun:test';
import type { Message, Metadata, Part, ToolPart } from '@/lib/opencode/model';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

function createMessageEntry({
    id,
    role,
    createdAt,
}: {
    id: string;
    role: 'user' | 'assistant' | 'system';
    createdAt: number;
}): ChatMessageEntry {
    return {
        info: {
            id,
            role,
            time: { created: createdAt },
        } as Message,
        parts: [] as Part[],
    };
}

const execPart = (id: string, tool: string, metadata: Metadata): ToolPart => ({
    id, type: 'tool', tool, sessionID: 'session-1', messageID: 'a1', callID: id,
    state: { status: 'completed', input: {}, output: '', time: { start: 2, end: 3 }, metadata },
});

const activityTool = (id: string, tool: string, status: 'completed' | 'running' | 'error' = 'completed'): ToolPart => ({
    ...execPart(id, tool, {}),
    state: status === 'completed'
        ? { status, input: {}, output: '', time: { start: 2, end: 3 } }
        : status === 'running'
            ? { status, input: {}, time: { start: 2 } }
            : { status, input: {}, error: 'Tool failed', time: { start: 2, end: 3 } },
});
const activityText = (id: string, text: string, type: 'text' | 'reasoning' = 'text'): Part => ({
    id, sessionID: 'session-1', messageID: 'a1', type, text, time: { start: 2, end: 3 },
});

describe('projectTurnRecords', () => {
    test('groups exploration tools across adjacent assistant messages', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [activityTool('grep-1', 'grep')],
        };
        const assistant2 = {
            ...createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 3 }),
            parts: [activityTool('read-1', 'read')],
        };

        const projection = projectTurnRecords([user, assistant1, assistant2]);

        expect(projection.turns[0]?.explorationGroups).toHaveLength(1);
        expect(projection.turns[0]?.explorationGroups[0]?.anchorMessageId).toBe('a1');
        expect(projection.turns[0]?.explorationGroups[0]?.parts.map((part) => part.id)).toEqual(['grep-1', 'read-1']);
    });

    test('splits exploration groups at visible text', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                activityTool('grep-1', 'grep'),
                activityText('text-1', 'Checking the result.'),
                activityTool('read-1', 'read'),
            ],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['grep-1'], ['read-1']]);
    });

    test('uses reasoning visibility as an exploration boundary', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                activityTool('glob-1', 'glob'),
                activityText('reasoning-1', 'Inspecting candidates.', 'reasoning'),
                activityTool('read-1', 'read'),
            ],
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
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                activityTool('read-1', 'read:0'),
                activityTool('custom-read', 'plugin.read'),
                activityTool('grep-1', 'grep'),
            ],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.explorationGroups.map((group) => group.parts.map((part) => part.id)))
            .toEqual([['read-1'], ['grep-1']]);
    });

    test('keeps exploration activity segmented around indexed subagent tools', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                activityTool('read-1', 'read', 'running'),
                activityTool('task-1', 'subagent:0', 'running'),
                activityTool('grep-1', 'grep', 'running'),
            ],
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
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                activityTool('read-1', 'read', 'running'),
            ],
        };
        const appendedAssistant = {
            ...initialAssistant,
            parts: [
                ...initialAssistant.parts,
                activityTool('grep-1', 'grep', 'running'),
            ],
        };
        const splitAssistant = {
            ...appendedAssistant,
            parts: [
                ...appendedAssistant.parts,
                activityText('text-1', 'Now inspect a specific file.'),
                activityTool('read-2', 'read', 'running'),
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
            const tool = activityTool(`tool-${index}`, index % 2 === 0 ? 'grep' : 'read', 'running');
            if (index === 0 || index % 50 !== 0) return [tool];
            return [
                activityText(`text-${index}`, `Boundary ${index}`),
                tool,
            ];
        }).flat();
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
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
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('splits consecutive assistant replies across the user turns they follow', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, user2, assistant2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.turns[1]?.turnId).toBe('u2');
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.size).toBe(0);
    });

    test('does not render an assistant reply that arrives before any user turn', () => {
        // A page loaded from the middle of a session can start on an assistant
        // message; it has no turn to belong to and must not invent one.
        const orphan = createMessageEntry({ id: 'a0', role: 'assistant', createdAt: 1 });
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 2 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 3 });

        const projection = projectTurnRecords([orphan, user1, assistant1]);

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
        expect(projection.ungroupedMessageIds.has('a0')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a0')).toBe(false);
    });

    test('does not render orphan assistant messages as standalone ungrouped entries', () => {
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 1 });

        const projection = projectTurnRecords([assistant]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('a1')).toBe(false);
        expect(projection.indexes.messageToTurnId.has('a1')).toBe(false);
    });

    test('opens a turn at a subagent run report so the parent reply renders under it', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const report: ChatMessageEntry = {
            info: {
                id: 's1',
                sessionID: 'ses_1',
                role: 'synthetic',
                time: { created: 3 },
                text: '<subagent sessionID="ses_child" state="completed" description="review">\nok\n</subagent>',
                metadata: { source: 'subagent', childID: 'ses_child', state: 'completed' },
            },
            parts: [],
        };
        const reaction = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });

        const projection = projectTurnRecords([user, assistant, report, reaction]);

        expect(projection.turns.map((turn) => turn.turnId)).toEqual(['u1', 's1']);
        expect(projection.turns[1]?.assistantMessageIds).toEqual(['a2']);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(false);
    });

    test('keeps non-assistant orphan messages available as ungrouped entries', () => {
        const system = createMessageEntry({ id: 's1', role: 'system', createdAt: 1 });

        const projection = projectTurnRecords([system]);

        expect(projection.turns).toHaveLength(0);
        expect(projection.ungroupedMessageIds.has('s1')).toBe(true);
    });

    test('reuses unchanged turn records from the previous projection', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const user2 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });
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
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
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
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                execPart('exec-1', 'exec_command', { processRunning: true }),
                execPart('poll-1', 'write_stdin', { execDisplay: 'poll' }),
                execPart('terminate-1', 'terminate_exec', { execError: 'not found' }),
            ],
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
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [
                execPart('poll-1', 'write_stdin', { execDisplay: 'poll' }),
                execPart('terminate-1', 'terminate_exec', { execDisplay: 'terminate' }),
            ],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(false);
        expect(projection.turns[0]?.activityParts).toEqual([]);
        expect(projection.turns[0]?.activitySegments).toEqual([]);
    });

    test('keeps historical Todo calls in Activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [activityTool('todo-1', 'todowrite')],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(true);
        expect(projection.turns[0]?.activityParts.map((record) => record.id)).toEqual(['todo-1']);
        expect(projection.turns[0]?.activitySegments.flatMap((group) => group.parts.map((record) => record.id))).toEqual(['todo-1']);
    });

    test('keeps failed todo updates in Activity', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = {
            ...createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 }),
            parts: [activityTool('todo-1', 'todowrite', 'error')],
        };

        const projection = projectTurnRecords([user, assistant]);

        expect(projection.turns[0]?.hasTools).toBe(true);
        expect(projection.turns[0]?.activityParts.map((record) => record.id)).toEqual(['todo-1']);
        expect(projection.turns[0]?.activitySegments.flatMap((group) => group.parts.map((record) => record.id)))
            .toEqual(['todo-1']);
    });

    test('reuses the whole turns array when every turn is unchanged', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
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
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2], {
            mergeHiddenUserTurns: true,
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2']);
        expect(projection.ungroupedMessageIds.has('u2')).toBe(false);
    });

    test('keeps hidden user messages as separate turns when merging is disabled', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const hiddenUser = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });

        const projection = projectTurnRecords([user1, assistant1, hiddenUser, assistant2]);

        expect(projection.turns).toHaveLength(2);
        expect(projection.turns[1]?.turnId).toBe('u2');
    });

    test('does not merge a hidden user message when there is no previous turn', () => {
        const hiddenUser = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });

        const projection = projectTurnRecords([hiddenUser, assistant], {
            mergeHiddenUserTurns: true,
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.turnId).toBe('u1');
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1']);
    });

    test('chains merges across consecutive hidden user messages', () => {
        const user1 = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user1.parts = [{ id: 'p1', type: 'text', text: 'visible prompt' } as Part];
        const assistant1 = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
        const hidden1 = createMessageEntry({ id: 'u2', role: 'user', createdAt: 3 });
        const assistant2 = createMessageEntry({ id: 'a2', role: 'assistant', createdAt: 4 });
        const hidden2 = createMessageEntry({ id: 'u3', role: 'user', createdAt: 5 });
        const assistant3 = createMessageEntry({ id: 'a3', role: 'assistant', createdAt: 6 });

        const projection = projectTurnRecords([user1, assistant1, hidden1, assistant2, hidden2, assistant3], {
            mergeHiddenUserTurns: true,
        });

        expect(projection.turns).toHaveLength(1);
        expect(projection.turns[0]?.assistantMessageIds).toEqual(['a1', 'a2', 'a3']);
    });

    test('keeps text inline (not justification) when a message is blocked on a pending question', () => {
        const user = createMessageEntry({ id: 'u1', role: 'user', createdAt: 1 });
        user.parts = [{ id: 'p1', type: 'text', text: 'prompt' } as Part];
        const assistant = createMessageEntry({ id: 'a1', role: 'assistant', createdAt: 2 });
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
