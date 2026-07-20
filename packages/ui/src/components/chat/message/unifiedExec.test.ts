import { describe, expect, test } from 'bun:test';
import type { ToolPart } from '@opencode-ai/sdk/v2';

import {
    formatUnifiedExecDuration,
    getExecProcessRunning,
    getUnifiedExecCommand,
    getUnifiedExecOutput,
    getUnifiedExecStatus,
    getWriteStdinOperation,
    isExecProcessRunning,
    isWriteStdinPoll,
    redactExecFollowUpInput,
    shouldHideExecFollowUp,
    shouldHideExecFollowUpState,
} from './unifiedExec';

const toolPart = (tool: string, status: string, metadata: Record<string, unknown> = {}): ToolPart => ({
    id: `${tool}-1`,
    sessionID: 'session-1',
    messageID: 'message-1',
    callID: 'call-1',
    type: 'tool',
    tool,
    state: { status, metadata },
} as ToolPart);

describe('Unified Exec presentation', () => {
    test('hides successful follow-ups but preserves both error shapes', () => {
        expect(shouldHideExecFollowUp(toolPart('write_stdin', 'completed'))).toBe(true);
        expect(shouldHideExecFollowUp(toolPart('terminate_exec', 'running'))).toBe(true);
        expect(shouldHideExecFollowUp(toolPart('write_stdin', 'error'))).toBe(false);
        expect(shouldHideExecFollowUp(toolPart('terminate_exec', 'completed', { execError: 'not found' }))).toBe(false);
        expect(shouldHideExecFollowUp(toolPart('exec_command', 'completed'))).toBe(false);
        expect(shouldHideExecFollowUpState('write_stdin', 'completed', {})).toBe(true);
        expect(shouldHideExecFollowUpState('write_stdin', 'completed', { execError: 'stdin unavailable' })).toBe(false);
    });

    test('uses the backend-sanitized UI transcript and normalizes newlines', () => {
        expect(getUnifiedExecOutput({ output: 'failed\r\nnext' }, 'wrapped model output'))
            .toBe('failed\nnext');
        expect(getUnifiedExecOutput({}, 'fallback')).toBe('fallback');
    });

    test('prefers the metadata command without exposing follow-up input', () => {
        expect(getUnifiedExecCommand({ cmd: 'fallback' }, { command: 'npm test' }, 'title')).toBe('npm test');
        expect(getUnifiedExecCommand({ cmd: 'fallback' }, {}, 'title')).toBe('fallback');
        expect(redactExecFollowUpInput('write_stdin', { session_id: 1, chars: 'secret', close_stdin: true }))
            .toEqual({ session_id: 1, close_stdin: true });
        expect(redactExecFollowUpInput('exec_command', { cmd: 'npm test' })).toEqual({ cmd: 'npm test' });
    });

    test('distinguishes output polling from process input', () => {
        expect(isWriteStdinPoll({ session_id: 1 })).toBe(true);
        expect(isWriteStdinPoll({ session_id: 1, chars: '' })).toBe(true);
        expect(isWriteStdinPoll({ session_id: 1, chars: '\n' })).toBe(false);
        expect(isWriteStdinPoll({ session_id: 1, close_stdin: true })).toBe(false);
        expect(getWriteStdinOperation('pending', {})).toBe('preparing');
        expect(getWriteStdinOperation('pending', { chars: '\n' })).toBe('preparing');
        expect(getWriteStdinOperation('running', { session_id: 1 })).toBe('polling');
        expect(getWriteStdinOperation('running', { session_id: 1, chars: '\n' })).toBe('sending');
        expect(getWriteStdinOperation('running', { session_id: 1, close_stdin: true })).toBe('sending');
        expect(getWriteStdinOperation('completed', { session_id: 1 })).toBe(undefined);
    });

    test('formats unbounded short and long durations', () => {
        expect(formatUnifiedExecDuration(12_450)).toBe('12.4s');
        expect(formatUnifiedExecDuration(252_000)).toBe('4m 12s');
        expect(formatUnifiedExecDuration(5_040_000)).toBe('1h 24m');
        expect(formatUnifiedExecDuration(97_200_000)).toBe('1d 3h');
    });

    test('derives desktop statuses only from authoritative root metadata', () => {
        expect(getUnifiedExecStatus({}, 0, 'error')).toEqual({ kind: 'error', error: true });
        expect(getUnifiedExecStatus({ execError: 'failed' }, 0)).toEqual({ kind: 'error', error: true });
        expect(getUnifiedExecStatus({ execDisplay: 'poll', sessionExposed: true, durationMs: 400 }, 0)).toBeNull();
        expect(getUnifiedExecStatus({ execDisplay: 'root', execError: 'failed', processRunning: true, durationMs: 400 }, 0))
            .toEqual({ kind: 'error', error: true });
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: false }, 0, 'error'))
            .toEqual({ kind: 'error', error: true });
        expect(isExecProcessRunning('exec_command', { processRunning: true }, 'error')).toBe(false);
        expect(isExecProcessRunning('exec_command', { execError: 'failed', processRunning: true })).toBe(false);
        expect(getExecProcessRunning('exec_command', { processRunning: false }, 'running')).toBe(false);
        expect(getExecProcessRunning('exec_command', {}, 'running')).toBe(undefined);
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: true, sessionID: 1, startedAt: 1_000 }, 13_400))
            .toBeNull();
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: true, sessionExposed: true, startedAt: 1_000 }, 13_400))
            .toBeNull();
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: true, sessionID: 1, sessionExposed: true, startedAt: 1_000 }, 13_400))
            .toEqual({ kind: 'running', durationMs: 12_400, error: false });
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: false, durationMs: 26_100, exitCode: 0 }, 0))
            .toBeNull();
        expect(getUnifiedExecStatus({ execDisplay: 'root', sessionExposed: true, processRunning: false, durationMs: 26_100, exitCode: 0 }, 0))
            .toEqual({ kind: 'completed', durationMs: 26_100, error: false });
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: false, durationMs: 26_100, exitCode: 1 }, 0))
            .toEqual({ kind: 'exited', exitCode: 1, error: true });
        expect(getUnifiedExecStatus({ execDisplay: 'root', sessionExposed: true, processRunning: false, durationMs: 26_100, exitCode: 1 }, 0))
            .toEqual({ kind: 'exited', exitCode: 1, durationMs: 26_100, error: true });
        expect(getUnifiedExecStatus({ execDisplay: 'root', processRunning: false, durationMs: 26_100, terminationRequested: true }, 0))
            .toEqual({ kind: 'terminated', error: false });
        expect(getUnifiedExecStatus({ execDisplay: 'root', sessionExposed: true, processRunning: false, durationMs: 26_100, terminationRequested: true }, 0))
            .toEqual({ kind: 'terminated', durationMs: 26_100, error: false });
    });
});
