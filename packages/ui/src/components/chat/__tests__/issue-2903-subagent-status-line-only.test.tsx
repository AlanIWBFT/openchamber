/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/2903
 *
 * Busy embedded session-chat panels were rendering only the working-status row
 * ("…is running command") because ChatContainer gated message reads on the
 * same visibility flag used to keep the composer from stealing focus. When the
 * iframe booted inactive (or a visibility postMessage was lost),
 * useSessionMessageRecords returned [] while session status stayed busy — so
 * the empty-state branch was skipped and the transcript showed status only.
 *
 * Idle sessions hit the empty state instead (#2892). Same root cause.
 *
 * Fix: embedded session-chat keeps `messagesEnabled={true}` so history stays
 * subscribed while `active={embeddedBackgroundWorkEnabled}` still gates
 * composer focus and background work.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, Part } from '@opencode-ai/sdk/v2/client';

import { getSessionMaterializationStatus, materializeSessionSnapshots } from '@/sync/materialization';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(join(__dirname, '..', '..', '..', 'App.tsx'), 'utf-8');
const chatContainerSource = readFileSync(join(__dirname, '..', 'ChatContainer.tsx'), 'utf-8');
const chatViewSource = readFileSync(join(__dirname, '..', '..', 'views', 'ChatView.tsx'), 'utf-8');
const syncContextSource = readFileSync(join(__dirname, '..', '..', '..', 'sync', 'sync-context.tsx'), 'utf-8');

const SESSION_ID = 'ses_subagent_2903';

const createRecord = (id: string, role: 'user' | 'assistant', created: number) => ({
  info: {
    id,
    sessionID: SESSION_ID,
    role,
    time: { created },
    ...(role === 'assistant'
      ? { parentID: `u_${created}`, providerID: 'deepseek', modelID: 'deepseek-v4-flash' }
      : {}),
  } as Message,
  parts: [{
    id: `prt_${id}`,
    messageID: id,
    sessionID: SESSION_ID,
    type: 'text',
    text: role === 'user' ? `prompt ${created}` : `output ${created}`,
  }] as Part[],
});

/** 14-message subagent transcript, matching the issue reproduction fixture. */
const buildFourteenMessageSnapshot = () => {
  const records = Array.from({ length: 14 }, (_, index) => {
    const n = index + 1;
    return createRecord(
      n % 2 === 1 ? `u_${n}` : `a_${n}`,
      n % 2 === 1 ? 'user' : 'assistant',
      n,
    );
  });
  return materializeSessionSnapshots({ message: {}, part: {} }, SESSION_ID, records);
};

/**
 * Mirrors the cold-start branch of useSessionMessageRecords when
 * `options.enabled === false` and no prior snapshot exists for the session.
 */
const readRecordsThroughEnabledGate = (
  storeMessages: Message[] | undefined,
  enabled: boolean,
): Message[] => {
  if (enabled === false) {
    // Cold iframe: snapshotRef is empty / wrong session → EMPTY records.
    return [];
  }
  return storeMessages ?? [];
};

describe('issue #2903 busy embedded subagent status-line-only', () => {
  test('materialized 14-message subagent is renderable', () => {
    const snapshot = buildFourteenMessageSnapshot();
    expect(snapshot.message[SESSION_ID]).toHaveLength(14);
    expect(getSessionMaterializationStatus(snapshot, SESSION_ID)).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    });
  });

  test('inactive enabled:false hides a fully-renderable session (0 records)', () => {
    const snapshot = buildFourteenMessageSnapshot();
    expect(getSessionMaterializationStatus(snapshot, SESSION_ID).renderable).toBe(true);
    expect(readRecordsThroughEnabledGate(snapshot.message[SESSION_ID], false)).toHaveLength(0);
  });

  test('enabled:true reveals all 14 materialized records', () => {
    const snapshot = buildFourteenMessageSnapshot();
    expect(readRecordsThroughEnabledGate(snapshot.message[SESSION_ID], true)).toHaveLength(14);
  });

  test('sync gate still returns empty on cold disabled reads', () => {
    // Mutation check: the real hook still has the enabled===false early return
    // that produced the bug when ChatContainer passed enabled: active.
    expect(syncContextSource).toContain('if (options?.enabled === false)');
    expect(syncContextSource).toContain('EMPTY_SESSION_MESSAGE_RECORDS');
  });

  test('embedded session-chat keeps message history enabled while visibility gates active', () => {
    expect(appSource).toContain('messagesEnabled={true}');
    expect(appSource).toContain('active={embeddedBackgroundWorkEnabled}');
    expect(appSource).toContain('const [isEmbeddedVisible, setIsEmbeddedVisible] = React.useState(false);');
    expect(chatViewSource).toContain('messagesEnabled?: boolean');
    expect(chatContainerSource).toContain('messagesEnabled: messagesEnabledProp');
    expect(chatContainerSource).toContain('const messagesEnabled = messagesEnabledProp ?? active;');
    expect(chatContainerSource).toContain('enabled: messagesEnabled');
    expect(chatContainerSource.includes('enabled: active')).toBe(false);
  });

  test('empty+busy branch skips empty state so StatusRowContainer can stand alone', () => {
    // Busy + zero messages skips ChatEmptyState and falls through to the full
    // ChatViewport, whose transcript always includes StatusRowContainer — the
    // "one status line, no history" symptom when records stay empty.
    expect(chatContainerSource).toContain('if (sessionMessages.length === 0 && !sessionIsWorking)');
    expect(chatContainerSource).toContain('<ChatEmptyState');
    expect(chatContainerSource).toContain('<StatusRowContainer />');

    const emptyBusyGuard = 'if (sessionMessages.length === 0 && !sessionIsWorking)';
    const emptyStateReturn = chatContainerSource.indexOf(emptyBusyGuard);
    expect(emptyStateReturn).toBeGreaterThan(-1);
    const emptyStateBlock = chatContainerSource.slice(
      emptyStateReturn,
      emptyStateReturn + 1600,
    );
    expect(emptyStateBlock).toContain('<ChatEmptyState');
    expect(emptyStateBlock).not.toContain('<StatusRowContainer />');
  });

  test('visibility handshake remains as defense-in-depth for background work', () => {
    expect(appSource).toContain('requestEmbeddedSessionVisibility();');
    expect(appSource).toContain('EMBEDDED_VISIBILITY_UPDATE');
  });
});
