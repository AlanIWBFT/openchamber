import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { opencodeClient } from '@/lib/opencode/client';
import type { FormRequest, Session, SessionStatus } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import {
  applyGlobalSessionStatusEvent,
  replaceGlobalSessionStatusById,
  useGlobalSessionStatusStore,
} from './global-session-status';
import {
  HOST_STATUS_SEED_MAX_AGE_MS,
  buildHostStatusSeedEvents,
  seedGlobalSessionStatusFromHost,
} from './host-session-status-seed';
import { resetSessionOrdering } from './session-ordering';
import { resetSessionActivityTiming } from './session-activity-timing';
import { ChildStoreManager } from './child-store';
import { setSyncRefs } from './sync-refs';
import { resetGlobalBlockingRequests, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { recordDirectoryRecoveryEvent } from './directory-recovery-snapshots';

const NOW = 1_700_000_000_000;

const session = (id: string, directory: string): Session => ({
  id, directory, projectID: 'project', title: id,
  time: { created: 1, updated: 1 }, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

describe('buildHostStatusSeedEvents', () => {
  test('adds busy and retry entries as busy, grouped by resolved directory', () => {
    const events = buildHostStatusSeedEvents({
      serverTime: NOW,
      sessions: {
        a: { status: 'busy', lastUpdateAt: NOW - 1_000 },
        b: { status: 'retry', lastUpdateAt: NOW - 1_000 },
        c: { status: 'idle', lastUpdateAt: NOW },
      },
    }, {
      isKnown: () => false,
      resolveDirectory: (id) => (id === 'a' ? '/repo' : id === 'b' ? '/other' : null),
    });

    expect([...events.keys()]).toEqual(['/repo', '/other']);
    expect(events.get('/repo')).toEqual([{
      type: 'session.status',
      properties: { sessionID: 'a', status: { type: 'busy' } },
    }]);
    expect(events.get('/other')?.[0]?.properties).toEqual({ sessionID: 'b', status: { type: 'busy' } });
  });

  test('skips sessions the client already observed, stale entries, and unresolved directories', () => {
    const events = buildHostStatusSeedEvents({
      serverTime: NOW,
      sessions: {
        known: { status: 'busy', lastUpdateAt: NOW },
        stale: { status: 'busy', lastUpdateAt: NOW - HOST_STATUS_SEED_MAX_AGE_MS - 1 },
        fresh: { status: 'busy', lastUpdateAt: NOW - HOST_STATUS_SEED_MAX_AGE_MS },
        unplaced: { status: 'busy', lastUpdateAt: NOW },
      },
    }, {
      isKnown: (id) => id === 'known',
      resolveDirectory: (id) => (id === 'unplaced' ? null : '/repo'),
    });

    expect([...events.keys()]).toEqual(['/repo']);
    expect(events.get('/repo')).toEqual([{
      type: 'session.status',
      properties: { sessionID: 'fresh', status: { type: 'busy' } },
    }]);
  });
});

describe('seedGlobalSessionStatusFromHost', () => {
  let originalGetSnapshot: typeof opencodeClient.getHostSessionStatusSnapshot;
  let snapshot: Awaited<ReturnType<typeof opencodeClient.getHostSessionStatusSnapshot>>;
  let requests = 0;
  let stores: ChildStoreManager;
  let activeReads: number;
  let formReads: string[];
  let permissionReads: string[];
  let statuses: Record<string, SessionStatus> | null;
  let readStatuses: () => Promise<Record<string, SessionStatus> | null>;
  let readForms: () => Promise<FormRequest[]>;
  const restore: Array<() => void> = [];
  const pendingForm: FormRequest = { id: 'form', sessionID: 'settled-here', title: 'Pick', fields: [{ key: 'answer', type: 'boolean' }] };

  beforeEach(() => {
    stores = new ChildStoreManager();
    setSyncRefs(opencodeClient.getSdkClient(), stores, '/repo');
    resetGlobalBlockingRequests();
    activeReads = 0;
    formReads = [];
    permissionReads = [];
    statuses = {};
    readStatuses = async () => statuses;
    readForms = async () => [];
    const spies = [
      spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async () => { activeReads++; return readStatuses(); }),
      spyOn(opencodeClient, 'listPendingForms').mockImplementation(async (options) => {
        expect(options?.includeGlobal).toBe(false);
        const directory = options?.directories?.[0];
        if (!directory) throw new Error('Recovery needs a directory');
        formReads.push(directory);
        return readForms();
      }),
      spyOn(opencodeClient, 'listPendingPermissions').mockImplementation(async (options) => {
        expect(options?.includeGlobal).toBe(false);
        const directory = options?.directories?.[0];
        if (!directory) throw new Error('Recovery needs a directory');
        permissionReads.push(directory);
        return [];
      }),
    ];
    for (const spy of spies) restore.push(() => spy.mockRestore());
    replaceGlobalSessionStatusById(new Map());
    resetSessionOrdering();
    resetSessionActivityTiming();
    requests = 0;
    originalGetSnapshot = opencodeClient.getHostSessionStatusSnapshot;
    opencodeClient.getHostSessionStatusSnapshot = async () => {
      requests += 1;
      return snapshot;
    };
    useGlobalSessionsStore.getState().applySnapshot([
      session('busy-elsewhere', '/unopened'),
      session('settled-here', '/repo'),
    ], [], 'ready');
  });

  afterEach(() => {
    for (const undo of restore.splice(0).reverse()) undo();
    stores.disposeAll();
    resetGlobalBlockingRequests();
    opencodeClient.getHostSessionStatusSnapshot = originalGetSnapshot;
    replaceGlobalSessionStatusById(new Map());
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  });

  test('seeds an unopened directory session and never overrides a live observation', async () => {
    // A live idle arrived for this session before the host answered: the host
    // still lists it busy (its map lags), and the seed must not resurrect it.
    applyGlobalSessionStatusEvent('/repo', { type: 'session.idle', properties: { sessionID: 'settled-here' } });
    snapshot = {
      serverTime: NOW,
      sessions: {
        'busy-elsewhere': { status: 'busy', lastUpdateAt: NOW },
        'settled-here': { status: 'busy', lastUpdateAt: NOW },
      },
    };

    await seedGlobalSessionStatusFromHost();

    const state = useGlobalSessionStatusStore.getState();
    expect(state.statusById.get('busy-elsewhere')).toEqual({ status: { type: 'busy' }, directory: '/unopened' });
    expect(state.statusById.has('settled-here')).toBe(false);
    expect([...state.activeSessionIds]).toEqual(['busy-elsewhere']);
    expect(activeReads).toBe(0);
    expect(formReads).toEqual([]);
    expect(permissionReads).toEqual([]);
    expect(stores.children.size).toBe(0);
  });

  test('unopened pending requests stay host hints without creating or reading a directory', async () => {
    snapshot = { serverTime: NOW, sessions: {}, pending: { 'busy-elsewhere': {
      forms: [{ id: 'cached', sessionID: 'busy-elsewhere', title: 'Cached' }], permissions: [],
    } } };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalBlockingRequestsStore.getState().bySession.get('busy-elsewhere')?.forms[0].id).toBe('cached');
    expect(stores.children.size).toBe(0);
    expect(activeReads).toBe(0);
    expect(formReads).toEqual([]);
    expect(permissionReads).toEqual([]);
  });

  test('recovers complete forms only for existing stores and does not repeat confirmed hints', async () => {
    const store = stores.ensureChild('/repo', { bootstrap: false });
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'retry', lastUpdateAt: 1 } } };
    statuses = { 'settled-here': { type: 'busy' }, 'busy-elsewhere': { type: 'busy' } };
    readForms = async () => [pendingForm];
    await seedGlobalSessionStatusFromHost();
    expect(store.getState().form['settled-here']).toEqual([pendingForm]);
    expect(store.getState().session_status).toEqual({ 'settled-here': { type: 'busy' } });
    expect(stores.getChild('/unopened')).toBeUndefined();
    expect(stores.getBootstrapState('/repo')).toBeUndefined();
    expect(formReads).toEqual(['/repo']);
    await seedGlobalSessionStatusFromHost();
    expect(activeReads).toBe(1);
    await seedGlobalSessionStatusFromHost(true);
    expect(activeReads).toBe(2);
  });

  test('shares one global active read across opened stores without assigning foreign sessions to them', async () => {
    const first = stores.ensureChild('/repo', { bootstrap: false });
    const second = stores.ensureChild('/other', { bootstrap: false });
    useGlobalSessionsStore.getState().applySnapshot([session('settled-here', '/repo'), session('second', '/other'), session('busy-elsewhere', '/unopened')], [], 'ready');
    snapshot = { serverTime: NOW, sessions: {
      'settled-here': { status: 'busy', lastUpdateAt: NOW }, second: { status: 'busy', lastUpdateAt: NOW },
      'busy-elsewhere': { status: 'busy', lastUpdateAt: NOW },
    } };
    statuses = { 'settled-here': { type: 'busy' }, second: { type: 'busy' }, 'busy-elsewhere': { type: 'busy' } };
    await seedGlobalSessionStatusFromHost();
    expect(activeReads).toBe(1);
    expect(first.getState().session_status).toEqual({ 'settled-here': { type: 'busy' } });
    expect(second.getState().session_status).toEqual({ second: { type: 'busy' } });
    expect(formReads.sort()).toEqual(['/other', '/repo']);
    expect(useGlobalSessionStatusStore.getState().statusById.get('busy-elsewhere')?.directory).toBe('/unopened');
  });

  test('a scoped active snapshot cannot clear an unopened session attributed to the same previous reader', async () => {
    stores.ensureChild('/repo', { bootstrap: false });
    replaceGlobalSessionStatusById(new Map([['busy-elsewhere', { directory: '/repo', status: { type: 'busy' } }]]));
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'busy', lastUpdateAt: NOW } } };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('busy-elsewhere')).toBe(true);
    expect(stores.getChild('/unopened')).toBeUndefined();
  });

  test('failed active reads preserve busy state and retry an unconfirmed hint', async () => {
    const store = stores.ensureChild('/repo', { bootstrap: false });
    replaceGlobalSessionStatusById(new Map([['settled-here', { directory: '/repo', status: { type: 'busy' } }]]));
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'busy', lastUpdateAt: NOW } } };
    statuses = null;
    await seedGlobalSessionStatusFromHost();
    expect(store.getState().sessionStatusReady).toBe(false);
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(true);
    statuses = {};
    await seedGlobalSessionStatusFromHost();
    expect(activeReads).toBe(2);
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(false);
  });

  test('a reply during recovery prevents stale forms from reappearing locally or globally', async () => {
    const store = stores.ensureChild('/repo', { bootstrap: false });
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'busy', lastUpdateAt: NOW } } };
    readForms = async () => {
      recordDirectoryRecoveryEvent(store, { type: 'form.settled', properties: { sessionID: 'settled-here', formID: pendingForm.id } });
      return [pendingForm];
    };
    await seedGlobalSessionStatusFromHost();
    expect(store.getState().form).toEqual({});
    expect(useGlobalBlockingRequestsStore.getState().bySession.size).toBe(0);
  });

  test('replacing the sync owner rejects the old recovery', async () => {
    stores.ensureChild('/repo', { bootstrap: false });
    const replacement = new ChildStoreManager();
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'busy', lastUpdateAt: NOW } } };
    readStatuses = async () => {
      setSyncRefs(opencodeClient.getSdkClient(), replacement, '/other');
      return { 'settled-here': { type: 'busy' } };
    };
    try {
      await seedGlobalSessionStatusFromHost();
      expect(useGlobalSessionStatusStore.getState().statusById.size).toBe(0);
    } finally { replacement.disposeAll(); }
  });

  test('reconnect during a host read requests one fresh recovery', async () => {
    stores.ensureChild('/repo', { bootstrap: false });
    snapshot = { serverTime: NOW, sessions: { 'settled-here': { status: 'busy', lastUpdateAt: NOW } } };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const load = opencodeClient.getHostSessionStatusSnapshot;
    opencodeClient.getHostSessionStatusSnapshot = async () => {
      const response = await load();
      if (requests === 1) await blocked;
      return response;
    };
    const first = seedGlobalSessionStatusFromHost();
    const reconnect = seedGlobalSessionStatusFromHost(true);
    release();
    await Promise.all([first, reconnect]);
    expect(requests).toBe(2);
    expect(activeReads).toBe(1);
  });

  test('a failed fetch and an absent entry leave existing activity untouched', async () => {
    applyGlobalSessionStatusEvent('/repo', { type: 'session.status', properties: { sessionID: 'settled-here', status: { type: 'busy' } } });
    snapshot = null;
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(true);

    snapshot = { serverTime: NOW, sessions: {} };
    await seedGlobalSessionStatusFromHost();
    expect(useGlobalSessionStatusStore.getState().statusById.has('settled-here')).toBe(true);
  });

  test('coalesces overlapping calls into one request', async () => {
    snapshot = { serverTime: NOW, sessions: {} };
    await Promise.all([seedGlobalSessionStatusFromHost(), seedGlobalSessionStatusFromHost()]);
    expect(requests).toBe(1);
    await seedGlobalSessionStatusFromHost();
    expect(requests).toBe(2);
  });
});
