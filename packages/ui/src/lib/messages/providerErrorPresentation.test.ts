import { describe, expect, test } from 'bun:test';
import type { OpenCodeEvent } from '@opencode/client';
import type { AssistantMessage, Message } from '@/lib/opencode/model';
import { translateWireEvent } from '@/lib/opencode/events';
import { applyDirectoryEvent } from '@/sync/event-reducer';
import { INITIAL_STATE, type State } from '@/sync/types';
import { getProviderErrorPresentation } from './providerErrorPresentation';

const assistant: AssistantMessage = {
    id: 'msg_a', sessionID: 'ses_1', role: 'assistant', seq: 3, time: { created: 1 }, agent: 'build', providerID: 'p', modelID: 'm',
};
const present = (message: Message) => getProviderErrorPresentation(message, (key) => key);

describe('provider error presentation', () => {
    test('a persisted terminal classification enables the model picker', () => {
        expect(present({ ...assistant, error: {
            type: 'Forbidden', message: 'Provider detail',
            resolution: { kind: 'plan_not_included', retry: 'never', action: 'switch_model' },
        } })).toEqual({ text: 'chat.providerError.planNotIncluded', variant: 'error', switchModel: true });
    });

    test('a failed partial message can still have a scheduled continuation', () => {
        expect(present({ ...assistant,
            retry: { attempt: 2, at: 10, error: {
                type: 'Temporary', message: 'Retrying', resolution: { kind: 'server', retry: 'automatic', action: 'retry' },
            } },
            error: { type: 'BadRequest', message: 'Invalid input', resolution: { kind: 'invalid_input', retry: 'never', action: 'fix_input' } },
        })).toEqual({ text: 'chat.providerError.server chat.providerError.retryScheduled', variant: 'info', switchModel: false });
    });

    test('native retry notice appears, clears on the next attempt, and settles on failure', () => {
        const state: State = { ...INITIAL_STATE, message: { ses_1: [assistant] }, part: {}, sessionEventRevision: {}, sessionDeletedRevision: {} };
        const dispatch = (wire: OpenCodeEvent) => {
            for (const event of translateWireEvent(wire)) applyDirectoryEvent(state, event);
        };
        const base = { id: 'evt_1', created: 2, durable: { aggregateID: 'ses_1', seq: 5, version: 1 as const } };
        dispatch({ ...base, type: 'session.retry.scheduled', data: {
            sessionID: 'ses_1', assistantMessageID: 'msg_a', attempt: 2, at: 10,
            error: { type: 'RateLimit', message: 'Rate limited', resolution: { kind: 'rate_limited', retry: 'automatic', action: 'wait' } },
        } });
        expect(present(state.message.ses_1[0])).toEqual({ text: 'chat.providerError.rateLimited chat.providerError.retryScheduled', variant: 'info', switchModel: false });

        dispatch({ ...base, type: 'session.step.started', data: {
            sessionID: 'ses_1', assistantMessageID: 'msg_a', agent: 'build', model: { id: 'm', providerID: 'p' }, started: 10,
        } });
        expect(present(state.message.ses_1[0])).toBeUndefined();
        expect(state.message.ses_1[0].seq).toBe(3);

        dispatch({ ...base, type: 'session.step.failed', data: {
            sessionID: 'ses_1', assistantMessageID: 'msg_a',
            error: { type: 'Forbidden', message: 'Denied', resolution: { kind: 'authentication', retry: 'never', action: 'reauthenticate' } },
        } });
        expect(present(state.message.ses_1[0])).toEqual({ text: 'chat.providerError.authentication', variant: 'error', switchModel: false });
    });

    test('unclassified native and provisional retries remain informational', () => {
        const error = { type: 'Transient', message: 'Retry detail' };
        expect(present({ ...assistant, retry: { attempt: 2, at: 10, error } })).toMatchObject({ variant: 'info', switchModel: false });
        expect(present({ ...assistant, error: { ...error, type: 'SessionRetry' } })).toMatchObject({ variant: 'info', switchModel: false });
    });

    for (const transition of ['new-step', 'idle', 'error']) test(`clears the current continuation notice on ${transition}`, () => {
        const error = { type: 'Temporary', message: 'Unavailable', resolution: { kind: 'server', retry: 'automatic', action: 'retry' } } as const;
        const current: AssistantMessage = { ...assistant, error, time: { created: 1, completed: 2 }, retry: { attempt: 2, at: 10, error } };
        const state: State = { ...INITIAL_STATE, message: { ses_1: [current] }, part: {}, sessionEventRevision: {}, sessionDeletedRevision: {} };
        if (transition === 'new-step') {
            applyDirectoryEvent(state, { type: 'message.updated', properties: {
                info: { ...assistant, id: 'msg_next', seq: undefined }, stepStartedSeq: 5,
            } });
        } else if (transition === 'error') {
            applyDirectoryEvent(state, { type: 'session.error', properties: { sessionID: 'ses_1', error } });
        } else {
            applyDirectoryEvent(state, { type: 'session.idle', properties: { sessionID: 'ses_1' } });
        }
        expect(present(state.message.ses_1[0])).toEqual({ text: 'chat.providerError.server', variant: 'error', switchModel: false });
        expect(current.retry).toBeDefined();
    });

    test('replayed older starts do not clear a newer assistant retry', () => {
        const current: AssistantMessage = { ...assistant, seq: 10, retry: { attempt: 2, at: 20, error: { type: 'Temporary', message: 'Retrying' } } };
        const state: State = { ...INITIAL_STATE, message: { ses_1: [current] }, part: {}, sessionEventRevision: {}, sessionDeletedRevision: {} };
        applyDirectoryEvent(state, { type: 'message.updated', properties: {
            info: { ...assistant, id: 'msg_old', seq: undefined }, stepStartedSeq: 5,
        } });
        expect(state.message.ses_1[0]).toBe(current);
        expect(present(current)?.variant).toBe('info');
    });
});
