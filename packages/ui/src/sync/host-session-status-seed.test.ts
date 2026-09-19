import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import { hostSessionStatusSnapshotSchema } from '@/lib/opencode/session-status';
import { createOpencodeClient, type QuestionRequest } from '@opencode-ai/sdk/v2';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { replaceGlobalSessionStatusById, useGlobalSessionStatusStore } from './global-session-status';
import { resetGlobalBlockingRequests, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { seedGlobalSessionStatusFromHost } from './host-session-status-seed';
import { ChildStoreManager } from './child-store';
import { setSyncRefs } from './sync-refs';
import { recordDirectoryRecoveryEvent } from './directory-recovery-snapshots';

const session = (id: string, directory: string) => ({
  id, slug: id, directory, projectID: 'project', title: id, version: '1', time: { created: 1, updated: 1 },
});
const question = { id: 'q1', sessionID: 'active', questions: [{ header: 'Pick', question: 'Pick one', options: [], custom: false }] };

describe('targeted host status recovery', () => {
  const original = {
    host: opencodeClient.getHostSessionStatusSnapshot,
    status: opencodeClient.getSessionStatusForDirectory,
    sdk: opencodeClient.getSdkClient,
  };
  let stores: ChildStoreManager;
  let statusReads: string[];
  let hostReads: number;
  let readQuestions: () => Promise<QuestionRequest[]>;

  beforeEach(() => {
    stores = new ChildStoreManager();
    readQuestions = async () => [];
    const sdk = createOpencodeClient({ baseUrl: 'http://host-recovery.test', fetch: async (request) => {
      const url = new URL(new Request(request).url);
      expect(url.searchParams.get('directory')).toBe('/unopened');
      if (url.pathname === '/question') return Response.json(await readQuestions());
      if (url.pathname === '/permission') return Response.json([]);
      throw new Error(`Unexpected recovery request: ${url.pathname}`);
    } });
    opencodeClient.getSdkClient = () => sdk;
    setSyncRefs(opencodeClient.getSdkClient(), stores, '/selected');
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    statusReads = [];
    hostReads = 0;
    useGlobalSessionsStore.getState().applySnapshot([session('active', '/unopened'), session('idle', '/idle')], [], 'ready');
    opencodeClient.getHostSessionStatusSnapshot = async () => {
      hostReads += 1;
      return { serverTime: 10_000_000, sessions: { active: { status: 'retry', lastUpdateAt: 1 }, idle: { status: 'idle', lastUpdateAt: 1 } }, pending: {} };
    };
    opencodeClient.getSessionStatusForDirectory = async (directory) => {
      if (!directory) throw new Error('Recovery must name its directory');
      statusReads.push(directory);
      return {};
    };
  });
  afterEach(() => {
    opencodeClient.getHostSessionStatusSnapshot = original.host;
    opencodeClient.getSessionStatusForDirectory = original.status;
    opencodeClient.getSdkClient = original.sdk;
    stores.disposeAll();
    replaceGlobalSessionStatusById(new Map());
    resetGlobalBlockingRequests();
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  test('confirms old activity hints without bootstrapping idle projects or repeating unchanged hints', async () => {
    await seedGlobalSessionStatusFromHost();
    expect(statusReads).toEqual(['/unopened']);
    expect(stores.getChild('/idle')).toBeUndefined();
    expect(stores.getBootstrapState('/unopened')).toBeUndefined();
    expect(stores.getChild('/unopened')?.getState().sessionStatusReady).toBe(true);
    expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
    await seedGlobalSessionStatusFromHost();
    expect(statusReads).toHaveLength(1);
    await seedGlobalSessionStatusFromHost(true);
    expect(statusReads).toHaveLength(2);
  });

  test('keeps complete retry metadata and the custom-answer policy from authoritative reads', async () => {
    const host = hostSessionStatusSnapshotSchema.parse({ sessions: {}, serverTime: 1, pending: { active: { permissions: [], questions: [question] } } });
    expect(host.pending?.active.questions[0].questions[0].custom).toBe(false);
    const retry = { type: 'retry' as const, attempt: 2, message: 'Retry', next: 123, resolution: { kind: 'network' as const, retry: 'automatic' as const, action: 'check_network' as const } };
    opencodeClient.getSessionStatusForDirectory = async () => ({ active: retry });
    readQuestions = async () => [question];
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.get('active')?.status).toEqual(retry);
    expect(useGlobalBlockingRequestsStore.getState().bySession.get('active')?.questions).toEqual([question]);
  });

  test('does not turn failed reads into idle and retries an unconfirmed hint', async () => {
    replaceGlobalSessionStatusById(new Map([['active', { directory: '/unopened', status: { type: 'busy' } }]]));
    opencodeClient.getSessionStatusForDirectory = async () => null;
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('active')).toBe(true);
    expect(stores.getChild('/unopened')?.getState().sessionStatusReady).toBe(false);
    opencodeClient.getSessionStatusForDirectory = async () => ({});
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('active')).toBe(false);
  });

  test('a reply during recovery prevents a stale question from being restored globally', async () => {
    readQuestions = async () => {
      const store = stores.getChild('/unopened')!;
      recordDirectoryRecoveryEvent(store, { id: 'reply', type: 'question.replied', properties: { sessionID: 'active', requestID: 'q1', answers: [] } });
      return [question];
    };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalBlockingRequestsStore.getState().bySession.has('active')).toBe(false);
    expect(stores.getChild('/unopened')?.getState().question).toEqual({});
  });

  test('rejects completions after the owning sync runtime is replaced', async () => {
    const replacement = new ChildStoreManager();
    opencodeClient.getSessionStatusForDirectory = async () => {
      setSyncRefs(opencodeClient.getSdkClient(), replacement, '/other');
      return { active: { type: 'busy' } };
    };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
    replacement.disposeAll();
  });

  test('coalesces overlapping host reads', async () => {
    await Promise.all([seedGlobalSessionStatusFromHost(), seedGlobalSessionStatusFromHost()]);
    expect(hostReads).toBe(1);
  });

  test('a reconnect during the host read discards it and performs one fresh recovery', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const load = opencodeClient.getHostSessionStatusSnapshot;
    opencodeClient.getHostSessionStatusSnapshot = async () => {
      const snapshot = await load();
      if (hostReads === 1) await blocked;
      return snapshot;
    };
    const first = seedGlobalSessionStatusFromHost();
    const reconnect = seedGlobalSessionStatusFromHost(true);
    release();
    await Promise.all([first, reconnect]);
    expect(hostReads).toBe(2);
    expect(statusReads).toEqual(['/unopened']);
  });
});
