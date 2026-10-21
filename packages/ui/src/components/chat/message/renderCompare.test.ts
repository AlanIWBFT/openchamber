import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, CompactionMessage } from '@/lib/opencode/model';
import type { TurnGroupingContext } from '../lib/turns/types';
import { areRelevantTurnGroupingContextsEqual, areRenderRelevantMessagesEqual } from './renderCompare';

const finalAnswerContext: TurnGroupingContext = {
  turnId: 'turn',
  isFirstAssistantInTurn: false,
  isLastAssistantInTurn: true,
  isLatestTurn: true,
  isWorking: false,
  hasTools: false,
  hasReasoning: false,
};

describe('earlier assistant text context', () => {
  test('updates the final answer when earlier text appears, changes or disappears', () => {
    const withEarlierText = { ...finalAnswerContext, earlierAssistantText: ['Looking at the files.'] };
    const changed = { ...finalAnswerContext, earlierAssistantText: ['Looking at the files now.'] };
    expect(areRelevantTurnGroupingContextsEqual(finalAnswerContext, withEarlierText, 'answer', false)).toBe(false);
    expect(areRelevantTurnGroupingContextsEqual(withEarlierText, finalAnswerContext, 'answer', false)).toBe(false);
    expect(areRelevantTurnGroupingContextsEqual(withEarlierText, changed, 'answer', false)).toBe(false);
  });

  test('preserves equivalent rebuilt context', () => {
    expect(areRelevantTurnGroupingContextsEqual(finalAnswerContext, { ...finalAnswerContext }, 'answer', false)).toBe(true);
    expect(areRelevantTurnGroupingContextsEqual(
      { ...finalAnswerContext, earlierAssistantText: ['Looking at the files.'] },
      { ...finalAnswerContext, earlierAssistantText: ['Looking at the files.'] },
      'answer',
      false,
    )).toBe(true);
  });

  test('does not invalidate the user message for assistant decoration', () => {
    expect(areRelevantTurnGroupingContextsEqual(
      finalAnswerContext,
      { ...finalAnswerContext, earlierAssistantText: ['Looking at the files.'] },
      'user',
      true,
    )).toBe(true);
  });
});

describe('completed-turn changed files', () => {
  const files = [{ file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: false }];

  test('re-renders when the turn diff later lists a file whose counts did not change', () => {
    const before = { ...finalAnswerContext, changedFiles: files };
    const after = { ...finalAnswerContext, changedFiles: [{ ...files[0], inTurnDiff: true }] };
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'answer', false)).toBe(false);
  });

  test('preserves an equivalent rebuilt file list', () => {
    const before = { ...finalAnswerContext, changedFiles: files };
    const after = { ...finalAnswerContext, changedFiles: [{ ...files[0] }] };
    expect(areRelevantTurnGroupingContextsEqual(before, after, 'answer', false)).toBe(true);
  });
});

describe('message failure state', () => {
  const message: AssistantMessage = {
    id: 'reply', sessionID: 'session', role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'test', modelID: 'test',
  };
  const error = { type: 'provider.transport', message: 'WebSocket closed with code 1006' };
  const same = (left: AssistantMessage, right: AssistantMessage) => areRenderRelevantMessagesEqual({ info: left, parts: [] }, { info: right, parts: [] });

  test('invalidates an error added, replaced or cleared under the same message ID', () => {
    const failed = { ...message, error };
    expect(same(message, failed)).toBe(false);
    expect(same(failed, message)).toBe(false);
    expect(same(failed, { ...failed, error: { ...error, message: 'Connection recovered' } })).toBe(false);
  });

  test('preserves rebuilt message records and unrelated usage changes with the same failure state', () => {
    const retrying = { ...message, error, retry: { attempt: 1, at: 10, error } };
    expect(same(retrying, { ...retrying })).toBe(true);
    expect(same(retrying, { ...retrying, cost: 1 })).toBe(true);
  });
});

describe('running compaction', () => {
  const running: CompactionMessage = {
    id: 'msg_compact', sessionID: 'ses_1', role: 'compaction', time: { created: 1 }, status: 'running', reason: 'auto', summary: '',
  };

  test('re-renders as the summary streams in', () => {
    const grown = { ...running, summary: 'Summary so far' };
    expect(areRenderRelevantMessagesEqual({ info: running, parts: [] }, { info: grown, parts: [] })).toBe(false);
  });

  test('preserves an equivalent rebuilt record', () => {
    expect(areRenderRelevantMessagesEqual({ info: running, parts: [] }, { info: { ...running }, parts: [] })).toBe(true);
  });
});
