import { hostTurnStart, type SessionTurnStart, type SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusEvents, applyGlobalSessionStatusSnapshot, hasBackgroundWork, useGlobalSessionStatusStore } from './global-session-status';
import { applyHostTurnStarts, needsHostTurnStarts } from './session-activity-timing';
import { seedSessionContextFromHost, sessionContextRevision } from './session-live-work';
import { applyGlobalBlockingRequestSnapshot, readHostBlockingRequestsSnapshot, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { getOptionalSyncChildStores } from './sync-refs';
import { beginSessionStatusRequest, readDirectoryStatusSnapshot, readDirectoryFormSnapshot, readDirectoryPermissionSnapshot, type DirectoryRecoverySource } from './directory-recovery-snapshots';
import { runBackgroundNetworkTask } from '@/lib/background-network';

export const HOST_STATUS_SEED_MAX_AGE_MS = 30 * 60_000;

type SeedDependencies = {
  isKnown: (sessionId: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
};

export const buildHostStatusSeedEvents = (
  snapshot: HostSessionStatusSnapshot,
  deps: SeedDependencies,
  maxAgeMs = HOST_STATUS_SEED_MAX_AGE_MS,
): Map<string, SyncEvent[]> => {
  const eventsByDirectory = new Map<string, SyncEvent[]>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.status !== 'busy' && entry.status !== 'retry') continue;
    if (snapshot.serverTime - entry.lastUpdateAt > maxAgeMs) continue;
    if (deps.isKnown(sessionId)) continue;
    const directory = deps.resolveDirectory(sessionId);
    if (!directory) continue;
    const events = eventsByDirectory.get(directory) ?? [];
    events.push({ type: 'session.status', properties: { sessionID: sessionId, status: { type: 'busy' } } });
    eventsByDirectory.set(directory, events);
  }
  return eventsByDirectory;
};

export const buildHostTurnStarts = (
  snapshot: HostSessionStatusSnapshot,
  isHeldHere: (sessionId: string) => boolean,
): Map<string, SessionTurnStart> => {
  const starts = new Map<string, SessionTurnStart>();
  for (const [sessionId, entry] of Object.entries(snapshot.sessions)) {
    if (entry.turnStartedAt === undefined) continue;
    const running = entry.status === 'busy' || entry.status === 'retry';
    if (!running && !isHeldHere(sessionId)) continue;
    starts.set(sessionId, hostTurnStart(entry.turnStartedAt, snapshot.serverTime));
  }
  return starts;
};

const isHeldHere = (sessionId: string, activeSessionIds: ReadonlySet<string>): boolean => (
  !activeSessionIds.has(sessionId) && hasBackgroundWork(sessionId, activeSessionIds)
);

let scope: {
  runtime: string;
  sdk: ReturnType<typeof opencodeClient.getSdkClient>;
  stores: ReturnType<typeof getOptionalSyncChildStores>;
  confirmed: WeakMap<DirectoryRecoverySource, string>;
  epoch: number;
  inFlight: Promise<void> | null;
} | null = null;

/** Unopened directories use host hints; only existing child stores receive authoritative recovery. */
export const seedGlobalSessionStatusFromHost = (force = false): Promise<void> => {
  const runtime = getRuntimeKey();
  const sdk = opencodeClient.getSdkClient();
  const stores = getOptionalSyncChildStores();
  if (!scope || scope.runtime !== runtime || scope.sdk !== sdk || scope.stores !== stores) {
    scope = { runtime, sdk, stores, confirmed: new WeakMap(), epoch: 0, inFlight: null };
  }
  const owner = scope;
  if (force) { owner.confirmed = new WeakMap(); owner.epoch += 1; }
  if (owner.inFlight) return owner.inFlight;
  const epoch = owner.epoch;
  const ownsScope = () => scope === owner && getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk && getOptionalSyncChildStores() === stores;
  const isCurrent = () => ownsScope() && owner.epoch === epoch;
  const requestedAt = Date.now();
  const contextSince = sessionContextRevision();
  const task = (async () => {
    const snapshot = await readHostBlockingRequestsSnapshot(async () => {
      const response = await opencodeClient.getHostSessionStatusSnapshot();
      return isCurrent() ? response : null;
    }, (sessionId) => {
      const session = useGlobalSessionsStore.getState().entityById.get(sessionId);
      return session ? resolveGlobalSessionDirectory(session) : null;
    }, (directory) => !isSpaceDirectory(directory) && !stores?.getChild(directory));
    if (!snapshot || !isCurrent()) return;
    const answeredAt = Date.now();
    const status = useGlobalSessionStatusStore.getState();
    const entities = useGlobalSessionsStore.getState().entityById;
    const events = buildHostStatusSeedEvents(snapshot, {
      isKnown: (sessionId) => status.statusById.has(sessionId) || status.observedById.has(sessionId),
      resolveDirectory: (sessionId) => {
        const session = entities.get(sessionId);
        const directory = session ? resolveGlobalSessionDirectory(session) : null;
        return directory && !isSpaceDirectory(directory) && !stores?.getChild(directory) ? directory : null;
      },
    });
    for (const [directory, payloads] of events) {
      applyGlobalSessionStatusEvents(directory, payloads);
    }
    const { activeSessionIds } = useGlobalSessionStatusStore.getState();
    const held = new Set(Object.keys(snapshot.sessions).filter((sessionId) => isHeldHere(sessionId, activeSessionIds)));
    applyHostTurnStarts(buildHostTurnStarts(snapshot, (sessionId) => held.has(sessionId)), held, { requestedAt, answeredAt });
    if (snapshot.context) seedSessionContextFromHost(new Map(Object.entries(snapshot.context)), contextSince);
    if (!stores) return;

    const active = useGlobalSessionStatusStore.getState().statusById;
    const waiting = useGlobalBlockingRequestsStore.getState().bySession;
    const candidates = new Map<string, Map<string, string>>();
    for (const id of new Set([...Object.keys(snapshot.sessions), ...Object.keys(snapshot.pending ?? {}), ...active.keys(), ...waiting.keys()])) {
      const hint = snapshot.sessions[id];
      const requests = snapshot.pending?.[id];
      if (hint?.status !== 'busy' && hint?.status !== 'retry' && !requests?.permissions.length && !requests?.forms.length && !active.has(id) && !waiting.has(id)) continue;
      const session = entities.get(id);
      const directory = session ? resolveGlobalSessionDirectory(session) : active.get(id)?.directory ?? waiting.get(id)?.directory;
      if (!directory || isSpaceDirectory(directory) || !stores.getChild(directory)) continue;
      const hints = candidates.get(directory) ?? new Map<string, string>();
      hints.set(id, JSON.stringify([hint, requests]));
      candidates.set(directory, hints);
    }
    for (const [directory, store] of stores.children) if (!candidates.has(directory)) owner.confirmed.delete(store);
    let statusRead: ReturnType<typeof opencodeClient.getActiveSessionStatuses> | undefined;
    const readStatuses = () => (statusRead ??= runBackgroundNetworkTask(() => {
      if (!isCurrent()) throw new Error('Stale host recovery');
      return opencodeClient.getActiveSessionStatuses();
    }, 'active-session').then((statuses) => statuses ?? null));
    await Promise.all([...candidates].map(async ([directory, hints]) => {
      const store = stores.getChild(directory);
      if (!store) return;
      const signature = JSON.stringify([...hints].sort(([a], [b]) => a.localeCompare(b)));
      if (owner.confirmed.get(store) === signature || !isCurrent()) return;
      stores.pin(directory);
      const current = () => isCurrent() && stores.getChild(directory) === store;
      const read = async <T,>(load: () => Promise<T>): Promise<T> => {
        const result = await runBackgroundNetworkTask(() => {
        if (!current()) throw new Error('Stale directory recovery');
        return load();
        }, 'active-session');
        if (result === undefined) throw new Error('Stale directory recovery');
        return result;
      };
      try {
        const acceptStatus = beginSessionStatusRequest(store);
        const results = await Promise.allSettled([
          readDirectoryStatusSnapshot(store, readStatuses, (statuses) => {
            if (!current() || !acceptStatus()) return false;
            const ids = new Set(hints.keys());
            const records = new Map(store.getState().session.map((session) => [session.id, session]));
            for (const session of useGlobalSessionsStore.getState().entityById.values()) records.set(session.id, session);
            for (const [id, session] of records) {
              if (resolveGlobalSessionDirectory(session) === directory) ids.add(id);
              else ids.delete(id);
            }
            const scoped = Object.fromEntries(Object.entries(statuses).filter(([id]) => ids.has(id)));
            store.setState({ session_status: scoped, sessionStatusReady: true });
            applyGlobalSessionStatusSnapshot(directory, scoped, ids, 'sessions');
            return true;
          }).then((statuses) => { if (statuses === null) throw new Error('Status recovery unavailable'); }),
          readDirectoryFormSnapshot(store, () => read(() => opencodeClient.listPendingForms({ directories: [directory] })), {
            isStale: () => !current(),
            commit: (form) => {
              store.setState({ form });
              applyGlobalBlockingRequestSnapshot(directory, { kind: 'forms', groups: form });
            },
          }),
          readDirectoryPermissionSnapshot(store, () => read(() => opencodeClient.listPendingPermissions({ directories: [directory] })), {
            isStale: () => !current(),
            commit: (permission) => {
              store.setState({ permission });
              applyGlobalBlockingRequestSnapshot(directory, { kind: 'permissions', groups: permission });
            },
          }),
        ]);
        if (current() && results.every((result) => result.status === 'fulfilled')) owner.confirmed.set(store, signature);
      } finally {
        stores.unpin(directory);
      }
    }));
  })().finally(() => {
    owner.inFlight = null;
    if (ownsScope() && owner.epoch !== epoch) return seedGlobalSessionStatusFromHost();
  });
  owner.inFlight = task;
  return task;
};

const TURN_START_REQUEST_DELAY_MS = 300;
let turnStartRequest: ReturnType<typeof setTimeout> | null = null;

export const requestHostTurnStarts = (): void => {
  if (turnStartRequest !== null) return;
  turnStartRequest = setTimeout(() => {
    turnStartRequest = null;
    if (needsHostTurnStarts()) void seedGlobalSessionStatusFromHost();
  }, TURN_START_REQUEST_DELAY_MS);
};
