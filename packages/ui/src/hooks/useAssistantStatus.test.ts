import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, SyntheticMessage, ToolInput, ToolPart, UserMessage } from '@/lib/opencode/model';

import {
    createAssistantStatusSignature,
    getActiveAssistantContext,
    parseAssistantStatusSignature,
} from './useAssistantStatus';

const userMessage = (id: string): UserMessage => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
});

const assistantMessage = (id: string, providerID: string, modelID: string): AssistantMessage => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 2 },
    agent: 'build',
    providerID,
    modelID,
});

const syntheticMessage = (id: string): SyntheticMessage => ({
    id,
    role: 'synthetic',
    sessionID: 'ses_1',
    time: { created: 3 },
    text: 'server plugin prompt',
});

describe('getActiveAssistantContext', () => {
    test('keeps the model when plumbing messages land after the assistant', () => {
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), assistant, syntheticMessage('synthetic_1')])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('reports the model recorded on the newest assistant message', () => {
        const prompt = userMessage('user_1');
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const laterPrompt = userMessage('user_2');

        expect(getActiveAssistantContext([prompt, assistant, laterPrompt])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('follows the newer assistant message when the model changed mid-session', () => {
        const firstUser = userMessage('user_1');
        const firstAssistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const secondUser = userMessage('user_2');
        const secondAssistant = assistantMessage('assistant_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the assistant message records none', () => {
        const assistant = assistantMessage('assistant_1', '', '');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });

    test('reports no assistant when the session has only prompts', () => {
        expect(getActiveAssistantContext([userMessage('user_1')])).toEqual({
            assistantId: null,
            model: null,
        });
    });

    test('shows the session record model while a prompt sent after a finished turn waits for its answer', () => {
        // A v2 user message records no model; the send switched the session
        // first, so the session record names the model the new turn runs on.
        const previousAssistant = { ...assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1'), time: { created: 2, completed: 3 } };
        const messages = [userMessage('user_1'), previousAssistant, userMessage('user_2')];

        expect(getActiveAssistantContext(messages, { providerID: 'openai', id: 'gpt-5.6-sol' })).toEqual({
            assistantId: previousAssistant.id,
            model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        });
        // Without a session record nothing is shown: naming the previous turn's
        // model would name the wrong one.
        expect(getActiveAssistantContext(messages)).toEqual({ assistantId: previousAssistant.id, model: null });
    });

    test('a turn still running keeps its model when a prompt is queued behind it', () => {
        const running = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), running, userMessage('user_2')])).toEqual({
            assistantId: running.id,
            model: { providerId: 'anthropic', modelId: 'claude-opus-4-1' },
        });
    });
});

const writeStdinPart = (status: 'pending' | 'running', input: ToolInput): ToolPart => ({
    id: `write-stdin-${status}`,
    sessionID: 'session-1',
    messageID: 'message-1',
    callID: 'call-1',
    type: 'tool',
    tool: 'write_stdin',
    state: status === 'pending'
        ? { status, input, raw: '' }
        : { status, input, time: { start: 1 } },
});

describe('assistant status signature', () => {
    test('preserves write_stdin operations through encoding', () => {
        const cases = [
            [writeStdinPart('pending', {}), 'preparing'],
            [writeStdinPart('running', { exec_id: 1, chars: '\n' }), 'sending'],
            [writeStdinPart('running', { exec_id: 1, close_stdin: true }), 'sending'],
        ] as const;

        for (const [part, expectedOperation] of cases) {
            const signature = createAssistantStatusSignature([part], 'session-1:message-1');
            const parsed = parseAssistantStatusSignature(signature);

            expect(parsed.activeToolName).toBe('write_stdin');
            expect(parsed.writeStdinOperation).toBe(expectedOperation);
        }
    });

    test('preserves poll_exec as a distinct active operation', () => {
        const part: ToolPart = {
            id: 'poll-running',
            sessionID: 'session-1',
            messageID: 'message-1',
            callID: 'call-1',
            type: 'tool',
            tool: 'poll_exec',
            state: { status: 'running', input: { exec_id: 1 }, time: { start: 1 } },
        };

        const parsed = parseAssistantStatusSignature(createAssistantStatusSignature([part], 'session-1:message-1'));
        expect(parsed.activeToolName).toBe('poll_exec');
        expect(parsed.writeStdinOperation).toBe(undefined);
    });
});
