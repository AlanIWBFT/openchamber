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
import { buildSessionMessageRecordsSnapshot } from '@/sync/sync-context';
import { INITIAL_STATE } from '@/sync/types';

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

describe('issue #2903 busy embedded subagent status-line-only', () => {
  test('materialized 14-message subagent is renderable and snapshottable', () => {
    const materialized = buildFourteenMessageSnapshot();
    expect(materialized.message[SESSION_ID]).toHaveLength(14);
    expect(getSessionMaterializationStatus(materialized, SESSION_ID)).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    });

    const records = buildSessionMessageRecordsSnapshot(
      { ...INITIAL_STATE, message: materialized.message, part: materialized.part },
      SESSION_ID,
    );
    expect(records.list).toHaveLength(14);
    expect(records.list.map((record) => record.info.id)).toEqual(
      materialized.message[SESSION_ID].map((message) => message.id),
    );
  });

  test('sync gate still returns empty on cold disabled reads', () => {
    const hookStart = syncContextSource.indexOf('export function useSessionMessageRecords(');
    const hookBody = syncContextSource.slice(hookStart, hookStart + 1800);
    expect(hookBody).toContain('if (options?.enabled === false)');
    expect(hookBody).toContain('EMPTY_SESSION_MESSAGE_RECORDS');
    expect(hookBody).toContain('snapshotRef.current.sessionID === sessionID ? snapshotRef.current.list');
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
