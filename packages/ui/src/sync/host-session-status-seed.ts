import type { SyncEvent } from '@/lib/opencode/events';
import { opencodeClient } from '@/lib/opencode/client';
import type { HostSessionStatusSnapshot } from '@/lib/opencode/session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusEvents, applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from './global-session-status';
import { applyGlobalBlockingRequestSnapshot, seedGlobalBlockingRequests, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { getOptionalSyncChildStores } from './sync-refs';
import { beginSessionStatusRequest, readDirectoryStatusSnapshot, readDirectoryFormSnapshot, readDirectoryPermissionSnapshot, type DirectoryRecoverySource } from './directory-recovery-snapshots';
import { runBackgroundNetworkTask } from '@/lib/background-network';

// Seeds the cross-directory status index from the host's own map.
//
// Directory bootstrap only runs for the directory the user is working in, so a
// turn that was already running in another project when this client started
// is invisible to the event stream until its next status event. The OpenChamber
// host (web server, or the VS Code extension host) has been listening to the
// single upstream stream the whole time and answers `/api/sessions/status` in
// one request without creating OpenCode instances.
//
// For unopened directories the seed is strictly additive: it only adds busy entries for sessions this
// client has not observed itself. Absence from the host map never clears
// anything, because the map has no directory and a missing entry proves
// nothing about a session the client already knows to be running. A live event
// that arrives before the seed wins, since the event path records every
// observed session and the seed skips those.
// Existing child stores instead receive event-reconciled authoritative reads;
// this recovery never creates a directory store or bootstraps its configuration.

// Nothing on the host reconciles its map against OpenCode after a stream gap,
// so a missed idle can leave `busy` there for the host's 24-hour retention.
// A running turn refreshes its entry at every agent-loop step; an entry older
// than this is not trusted as current activity. A genuinely long tool call
// past this age simply waits for its next event instead of being seeded.
export const HOST_STATUS_SEED_MAX_AGE_MS = 30 * 60_000;

type SeedDependencies = {
  isKnown: (sessionId: string) => boolean;
  resolveDirectory: (sessionId: string) => string | null;
};

/**
 * Turns the host snapshot into per-directory `session.status` events for the
 * sessions the client has no live observation of. Retry collapses to busy:
 * the host keeps no attempt details, and the next live event restores them.
 */
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
  const task = (async () => {
    const snapshot = await opencodeClient.getHostSessionStatusSnapshot();
    if (!snapshot || !isCurrent()) return;
    const status = useGlobalSessionStatusStore.getState();
    const entities = useGlobalSessionsStore.getState().entityById;
    const events = buildHostStatusSeedEvents(snapshot, {
      isKnown: (sessionId) => status.statusById.has(sessionId) || status.observedById.has(sessionId),
      resolveDirectory: (sessionId) => {
        const session = entities.get(sessionId);
        const directory = session ? resolveGlobalSessionDirectory(session) : null;
        return directory && !stores?.getChild(directory) ? directory : null;
      },
    });
    for (const [directory, payloads] of events) {
      applyGlobalSessionStatusEvents(directory, payloads);
    }
    // Retain the upstream additive cache behavior for unopened directories.
    // Host hints can be stale; they do not authorize clearing live state.
    const pending: Array<Parameters<typeof seedGlobalBlockingRequests>[0][number]> = [];
    for (const [sessionId, entry] of Object.entries(snapshot.pending ?? {})) {
      const session = entities.get(sessionId);
      const directory = session ? resolveGlobalSessionDirectory(session) : null;
      if (!directory || stores?.getChild(directory)) continue;
      pending.push({ sessionId, directory, permissions: entry.permissions, forms: entry.forms });
    }
    seedGlobalBlockingRequests(pending);
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
      if (!directory || !stores.getChild(directory)) continue;
      const hints = candidates.get(directory) ?? new Map<string, string>();
      hints.set(id, JSON.stringify([hint, requests]));
      candidates.set(directory, hints);
    }
    for (const [directory, store] of stores.children) if (!candidates.has(directory)) owner.confirmed.delete(store);
    let statusRead: ReturnType<typeof opencodeClient.getActiveSessionStatuses> | undefined;
    const readStatuses = () => (statusRead ??= runBackgroundNetworkTask(() => {
      if (!isCurrent()) throw new Error('Stale host recovery');
      return opencodeClient.getActiveSessionStatuses();
    }, 'active-session'));
    await Promise.all([...candidates].map(async ([directory, hints]) => {
      const store = stores.getChild(directory);
      if (!store) return;
      const signature = JSON.stringify([...hints].sort(([a], [b]) => a.localeCompare(b)));
      if (owner.confirmed.get(store) === signature || !isCurrent()) return;
      stores.pin(directory);
      const current = () => isCurrent() && stores.getChild(directory) === store;
      const read = <T,>(load: () => Promise<T>) => runBackgroundNetworkTask(() => {
        if (!current()) throw new Error('Stale directory recovery');
        return load();
      }, 'active-session');
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
