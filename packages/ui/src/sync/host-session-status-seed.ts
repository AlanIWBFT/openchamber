import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from './global-session-status';
import { applyGlobalBlockingRequestSnapshot, useGlobalBlockingRequestsStore } from './global-blocking-requests';
import { getSyncChildStores } from './sync-refs';
import { beginSessionStatusRequest, readDirectoryStatusSnapshot, readDirectoryPermissionSnapshot, readDirectoryQuestionSnapshot } from './directory-recovery-snapshots';
import { runBackgroundNetworkTask } from '@/lib/background-network';

// The host map can retain missed replies and idle transitions after an upstream
// gap. Use it only to select directories, including long-running tools whose
// last event is old. Do not bootstrap their config, MCP, session list or history.
// Unchanged hints already confirmed in this runtime need no repeated reads.

let scope: {
  runtime: string;
  sdk: ReturnType<typeof opencodeClient.getSdkClient>;
  stores: ReturnType<typeof getSyncChildStores>;
  confirmed: Map<string, string>;
  epoch: number;
  inFlight: Promise<void> | null;
} | null = null;

/** Host records select recovery directories; only OpenCode reads publish live truth. */
export const seedGlobalSessionStatusFromHost = (force = false): Promise<void> => {
  const runtime = getRuntimeKey();
  const sdk = opencodeClient.getSdkClient();
  const stores = getSyncChildStores();
  if (!scope || scope.runtime !== runtime || scope.sdk !== sdk || scope.stores !== stores) {
    scope = { runtime, sdk, stores, confirmed: new Map(), epoch: 0, inFlight: null };
  }
  const owner = scope;
  if (force) {
    owner.confirmed.clear();
    owner.epoch += 1;
  }
  if (owner.inFlight) return owner.inFlight;
  const epoch = owner.epoch;
  const ownsScope = () => scope === owner && getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk && getSyncChildStores() === stores;
  const isCurrent = () => ownsScope() && owner.epoch === epoch;
  const task = (async () => {
    const snapshot = await opencodeClient.getHostSessionStatusSnapshot();
    if (!snapshot || !isCurrent()) return;
    const entities = useGlobalSessionsStore.getState().entityById;
    const active = useGlobalSessionStatusStore.getState().statusById;
    const waiting = useGlobalBlockingRequestsStore.getState().bySession;
    const candidates = new Map<string, Map<string, string>>();
    for (const sessionId of new Set([...Object.keys(snapshot.sessions), ...Object.keys(snapshot.pending ?? {}), ...active.keys(), ...waiting.keys()])) {
      const status = snapshot.sessions[sessionId];
      const pending = snapshot.pending?.[sessionId];
      if (status?.status !== 'busy' && status?.status !== 'retry' && !pending?.permissions.length && !pending?.questions.length && !active.has(sessionId) && !waiting.has(sessionId)) continue;
      const session = entities.get(sessionId);
      const directory = session ? resolveGlobalSessionDirectory(session) : active.get(sessionId)?.directory ?? waiting.get(sessionId)?.directory;
      if (!directory) continue;
      const hints = candidates.get(directory) ?? new Map<string, string>();
      hints.set(sessionId, JSON.stringify([status, pending]));
      candidates.set(directory, hints);
    }
    for (const directory of owner.confirmed.keys()) if (!candidates.has(directory)) owner.confirmed.delete(directory);
    await Promise.all([...candidates].map(async ([directory, hints]) => {
      const signature = JSON.stringify([...hints].sort(([a], [b]) => a.localeCompare(b)));
      if (owner.confirmed.get(directory) === signature) return;
      if (!isCurrent()) return;
      stores.pin(directory);
      const store = stores.ensureChild(directory, { bootstrap: false });
      const current = () => isCurrent() && stores.getChild(directory) === store;
      const read = <T,>(load: () => Promise<T>) => runBackgroundNetworkTask(async () => {
        if (!current()) throw new Error('Stale host recovery');
        const result = await load();
        if (!current()) throw new Error('Stale host recovery');
        return result;
      }, 'active-session');
      try {
        const claimStatus = beginSessionStatusRequest(store);
        const results = await Promise.allSettled([
          readDirectoryStatusSnapshot(store, () => read(() => opencodeClient.getSessionStatusForDirectory(directory))).then((statuses) => {
            if (statuses === null) throw new Error('Status recovery unavailable');
            if (!current() || !claimStatus()) return;
            store.setState({ session_status: statuses, sessionStatusReady: true });
            applyGlobalSessionStatusSnapshot(directory, statuses, [...hints.keys()]);
          }),
          readDirectoryQuestionSnapshot(store, () => read(async () => {
            const response = await sdk.question.list({ directory }, { throwOnError: true });
            if (!Array.isArray(response.data)) throw new Error('Question recovery unavailable');
            return response.data;
          }), { isStale: () => !current(), commit: (questions) => {
              store.setState({ question: questions });
              applyGlobalBlockingRequestSnapshot(directory, { kind: 'questions', groups: questions });
            },
          }),
          readDirectoryPermissionSnapshot(store, () => read(async () => {
            const response = await sdk.permission.list({ directory }, { throwOnError: true });
            if (!Array.isArray(response.data)) throw new Error('Permission recovery unavailable');
            return response.data;
          }), { isStale: () => !current(), commit: (permissions) => {
              store.setState({ permission: permissions });
              applyGlobalBlockingRequestSnapshot(directory, { kind: 'permissions', groups: permissions });
            },
          }),
        ]);
        if (current() && results.every((result) => result.status === 'fulfilled')) owner.confirmed.set(directory, signature);
      } catch {
        // Preserve successful fields; the next host refresh retries this hint.
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
