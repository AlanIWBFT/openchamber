import { describe, expect, test } from 'bun:test';

import {
    resolveAssistantDisplayText,
    resolveAssistantTextStreaming,
} from './assistantTextVisibility';

describe('resolveAssistantTextStreaming', () => {
    test('streams live text whose part is not sealed', () => {
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            isFinalized: false,
        })).toBe(true);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            isFinalized: false,
        })).toBe(true);
    });

    test('releases a sealed part even while the turn stays blocked (#3277)', () => {
        // A message blocked on a pending question keeps the stream phase
        // forever; the pre-question text part is sealed (time.end is set the
        // moment the model moves on to the question) and must render in full.
        expect(resolveAssistantTextStreaming({
            streamPhase: 'streaming',
            isFinalized: true,
        })).toBe(false);
        expect(resolveAssistantTextStreaming({
            streamPhase: 'cooldown',
            isFinalized: true,
        })).toBe(false);
    });
});

describe('resolveAssistantDisplayText', () => {
    test('shows unfinished prose while streaming', () => {
        const text = 'line nine, fully written\n\nline ten, still growing';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: text,
            isStreaming: true,
        })).toBe(text);
    });

    test('passes incomplete Markdown through without waiting for a closing boundary', () => {
        for (const text of [
            'Introduction\n\n```ts\nconst unfinished =',
            '| Name | Value |\n| --- | --- |\n| unfinished',
            '$$\nx =',
            '<details>\n<summary>Details</summary>\n\nStill growing',
        ]) {
            expect(resolveAssistantDisplayText({ textContent: text, throttledTextContent: text, isStreaming: true })).toBe(text);
        }
    });

    test('reveals the full text once the part is not streaming', () => {
        const text = 'one\ntwo\nsealed tail without trailing newline';
        expect(resolveAssistantDisplayText({
            textContent: text,
            throttledTextContent: 'one',
            isStreaming: false,
        })).toBe(text);
    });
});
