import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2';

import { applyRetryOverlay } from './applyRetryOverlay';
import type { ChatMessageEntry } from './types';

const message = (id: string, role: 'user' | 'assistant'): ChatMessageEntry => ({
    info: {
        id,
        role,
        sessionID: 'ses_1',
        time: { created: 1 },
    } as Message,
    parts: [],
});

describe('applyRetryOverlay', () => {
    test('preserves a retry resolution on the assistant error', () => {
        const messages = [message('user_1', 'user'), message('assistant_1', 'assistant')];

        const result = applyRetryOverlay(messages, {
            sessionId: 'ses_1',
            message: 'Rate limited',
            resolution: { kind: 'rate_limited', retry: 'automatic', action: 'wait' },
            fallbackTimestamp: 1,
        });

        expect((result[1]?.info as { error?: unknown }).error).toEqual({
            name: 'SessionRetry',
            message: 'Rate limited',
            data: {
                message: 'Rate limited',
                resolution: { kind: 'rate_limited', retry: 'automatic', action: 'wait' },
            },
        });
    });
});
