import { describe, expect, test } from 'bun:test';
import type { AssistantMessage } from '@/lib/opencode/model';

import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';

const user: ChatMessageEntry = { info: { id: 'user_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } }, parts: [] };
const assistant: AssistantMessage = {
    id: 'assistant_1', role: 'assistant', sessionID: 'ses_1', time: { created: 2 }, agent: 'build', providerID: 'openai', modelID: 'test',
};
const input = { sessionId: 'ses_1', message: 'Rate limited', fallbackTimestamp: 3 };

describe('applyRetryOverlay', () => {
    test('preserves authoritative native retry resolution and message identity', () => {
        const info: AssistantMessage = { ...assistant, retry: {
            attempt: 2, at: 10,
            error: { type: 'RateLimit', message: 'Rate limited', resolution: { kind: 'rate_limited', retry: 'automatic', action: 'wait' } },
        } };
        const messages = [user, { info, parts: [] }];
        expect(applyRetryOverlay(messages, input)).toBe(messages);
    });

    test('keeps a terminal error instead of masking it with a retry notice', () => {
        const messages = [user, { info: { ...assistant, error: { type: 'Authentication', message: 'Unauthorized' } }, parts: [] }];
        expect(applyRetryOverlay(messages, input)).toBe(messages);
    });

    test('uses the domain error shape for a status-only fallback without mutating history', () => {
        const messages = [user, { info: assistant, parts: [] }];
        const result = applyRetryOverlay(messages, input);
        expect(result[1].info).toMatchObject({ error: { type: 'SessionRetry', message: 'Rate limited' } });
        expect(assistant.error).toBeUndefined();
        expect(result[0]).toBe(user);
    });

    test('creates a provisional notice only when no assistant is materialized', () => {
        const result = applyRetryOverlay([user], input);
        expect(result).toHaveLength(2);
        expect(result[1].info).toMatchObject({ role: 'assistant', error: { type: 'SessionRetry', message: 'Rate limited' } });
        expect(result[1].info.seq).toBeUndefined();
    });
});
