import type { StreamPhase } from '../types';

// A sealed part releases all held content, including while its message waits
// on a question or permission. Waiting for message completion would hide the
// text needed to answer that question (#3277).
export const resolveAssistantTextStreaming = (input: {
    streamPhase: StreamPhase;
    isFinalized: boolean;
}): boolean => {
    if (input.isFinalized) {
        return false;
    }
    return input.streamPhase === 'streaming' || input.streamPhase === 'cooldown';
};

export const resolveAssistantDisplayText = (input: {
    textContent: string;
    throttledTextContent: string;
    isStreaming: boolean;
}): string => {
    // Streamdown owns incomplete Markdown; settlement flushes the throttle.
    return input.isStreaming ? input.throttledTextContent : input.textContent;
};
