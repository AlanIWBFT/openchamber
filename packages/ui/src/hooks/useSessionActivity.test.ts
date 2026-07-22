import { describe, expect, test } from 'bun:test';
import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';

import { getSessionActivity } from './useSessionActivity';

const pendingAssistant = {
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1 },
} as Message;

const baseInput = {
  status: undefined,
  statusSnapshotReady: false,
  lastMessage: undefined,
  fallbackExpired: false,
  hasBlockingRequest: false,
} as const;

describe('getSessionActivity', () => {
  test('treats an omitted status as idle after a successful snapshot', () => {
    expect(getSessionActivity({
      ...baseInput,
      statusSnapshotReady: true,
      lastMessage: pendingAssistant,
    })).toEqual({
      phase: 'idle',
      isWorking: false,
      isBusy: false,
      isCooldown: false,
    });
  });

  test('uses an unfinished assistant only as an unresolved startup fallback', () => {
    expect(getSessionActivity({
      ...baseInput,
      lastMessage: pendingAssistant,
    })).toEqual({
      phase: 'busy',
      isWorking: true,
      isBusy: true,
      isCooldown: false,
    });

    expect(getSessionActivity({
      ...baseInput,
      lastMessage: pendingAssistant,
      fallbackExpired: true,
    }).isWorking).toBe(false);
  });

  test('reports busy and retry statuses as working', () => {
    expect(getSessionActivity({ ...baseInput, status: { type: 'busy' } })).toEqual({
      phase: 'busy',
      isWorking: true,
      isBusy: true,
      isCooldown: false,
    });

    const retry: SessionStatus = { type: 'retry', attempt: 1, message: 'retrying', next: 100 };
    expect(getSessionActivity({ ...baseInput, status: retry })).toEqual({
      phase: 'retry',
      isWorking: true,
      isBusy: false,
      isCooldown: false,
    });
  });

  test('lets a blocking request take priority over active status', () => {
    expect(getSessionActivity({
      ...baseInput,
      status: { type: 'busy' },
      hasBlockingRequest: true,
    }).isWorking).toBe(false);
  });
});
