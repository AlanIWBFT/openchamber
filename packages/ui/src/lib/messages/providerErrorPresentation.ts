import type { Message, StructuredError } from '@/lib/opencode/model';
import { isLikelyProviderAuthFailure, PROVIDER_AUTH_FAILURE_MESSAGE } from './providerAuthError';

const failureMessages = {
    rate_limited: 'chat.providerError.rateLimited',
    usage_limited: 'chat.providerError.usageLimited',
    plan_not_included: 'chat.providerError.planNotIncluded',
    quota_exceeded: 'chat.providerError.quotaExceeded',
    policy_blocked: 'chat.providerError.policyBlocked',
    authentication: 'chat.providerError.authentication',
    invalid_input: 'chat.providerError.invalidInput',
    network: 'chat.providerError.network',
    server: 'chat.providerError.server',
} as const satisfies Record<NonNullable<StructuredError['resolution']>['kind'], string>;

type FailureMessageKey = (typeof failureMessages)[keyof typeof failureMessages] | 'chat.providerError.retryScheduled';
type ErrorPresentation = { text: string; variant: 'error' | 'info'; switchModel: boolean };

/** Uses persisted V2 retry/error state, including after history readback. */
export function getProviderErrorPresentation(message: Message, translate: (key: FailureMessageKey) => string): ErrorPresentation | undefined {
    if (message.role !== 'assistant' && message.role !== 'compaction') return undefined;
    const retry = message.role === 'assistant' ? message.retry : undefined;
    const error = retry?.error ?? message.error;
    if (!error) return undefined;
    const pendingRetry = retry !== undefined || error.type === 'SessionRetry';
    if (error.resolution) {
        const detail = translate(failureMessages[error.resolution.kind]);
        return {
            text: pendingRetry ? `${detail} ${translate('chat.providerError.retryScheduled')}` : detail,
            variant: pendingRetry ? 'info' : 'error',
            switchModel: error.resolution.action === 'switch_model',
        };
    }
    const detail = error.message || error.type;
    if (!detail) return undefined;
    if (pendingRetry) {
        return { text: `Opencode failed to send a message. Retry attempt info: ${detail}`, variant: 'info', switchModel: false };
    }
    if (isLikelyProviderAuthFailure(detail)) {
        return { text: PROVIDER_AUTH_FAILURE_MESSAGE, variant: 'error', switchModel: false };
    }
    if (detail.trim().toLowerCase() === 'aborted') {
        return { text: 'The running turn was stopped before OpenCode could send the next message.', variant: 'info', switchModel: false };
    }
    return { text: `Opencode failed to send message with error: ${detail}`, variant: 'error', switchModel: false };
}
