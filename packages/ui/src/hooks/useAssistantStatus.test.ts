import { describe, expect, test } from 'bun:test';
import type { Message, ToolPart } from '@opencode-ai/sdk/v2';

import {
    createAssistantStatusSignature,
    getActiveAssistantContext,
    parseAssistantStatusSignature,
} from './useAssistantStatus';

const userMessage = (id: string, providerID: string, modelID: string): Message => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
    model: { providerID, modelID },
} as Message);

const assistantMessage = (id: string, parentID: string): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    parentID,
    time: { created: 2 },
} as Message);

describe('getActiveAssistantContext', () => {
    test('uses the active assistant parent model instead of the latest user selection', () => {
        const activeParent = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const assistant = assistantMessage('assistant_1', activeParent.id);
        const laterSelection = userMessage('user_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([activeParent, assistant, laterSelection])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('switches models only when a newer assistant links to the newer user message', () => {
        const firstUser = userMessage('user_1', 'anthropic', 'claude-opus-4-1');
        const firstAssistant = assistantMessage('assistant_1', firstUser.id);
        const secondUser = userMessage('user_2', 'openai', 'gpt-5.6-sol');
        const secondAssistant = assistantMessage('assistant_2', secondUser.id);

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the parent message is unavailable', () => {
        const assistant = assistantMessage('assistant_1', 'missing_user');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });
});

const writeStdinPart = (status: 'pending' | 'running', input: Record<string, unknown>): ToolPart => ({
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
            [writeStdinPart('running', { session_id: 1 }), 'polling'],
            [writeStdinPart('running', { session_id: 1, chars: '\n' }), 'sending'],
            [writeStdinPart('running', { session_id: 1, close_stdin: true }), 'sending'],
        ] as const;

        for (const [part, expectedOperation] of cases) {
            const signature = createAssistantStatusSignature([part], 'session-1:message-1');
            const parsed = parseAssistantStatusSignature(signature);

            expect(parsed.activeToolName).toBe('write_stdin');
            expect(parsed.writeStdinOperation).toBe(expectedOperation);
        }
    });
});
