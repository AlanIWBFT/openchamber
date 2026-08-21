import { create } from 'zustand';
import type { Event, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import {
  observeSessionActivityEvent,
  reconcileSessionActivitySnapshot,
  removeSessionOrdering,
} from './session-ordering';
import {
  observeSessionActivityTiming,
  reconcileSessionActivityTiming,
  removeSessionActivityTiming,
} from './session-activity-timing';

// Shared live busy/retry index for every directory. Global events update it
// incrementally and authoritative directory snapshots reconcile it, so each
// sidebar row can subscribe to one leaf instead of every child store.
//
// Only non-idle entries are kept; absence means idle. Entries carry their
// directory so a polled per-directory snapshot can authoritatively replace
// that directory's slice (the server omits idle sessions from snapshots).

type ActiveStatusType = 'busy' | 'retry';

type GlobalSessionStatusEntry = { status: SessionStatus; directory: string };

type GlobalSessionStatusState = {
  statusById: Map<string, GlobalSessionStatusEntry>;
  activeSessionIds: ReadonlySet<string>;
};

const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

const initialState: GlobalSessionStatusState = {
  statusById: new Map(),
  activeSessionIds: EMPTY_ACTIVE_SESSION_IDS,
};

export const useGlobalSessionStatusStore = create<GlobalSessionStatusState>(() => initialState);

// Runtime switching currently replaces statusById directly. Keep that boundary
// synchronized without making normal status mutations derive membership again.
const storeSetState = useGlobalSessionStatusStore.setState;
type GlobalSessionStatusStateUpdate = GlobalSessionStatusState
  | Partial<GlobalSessionStatusState>
  | ((state: GlobalSessionStatusState) => GlobalSessionStatusState | Partial<GlobalSessionStatusState>);

function setSynchronizedState(
  partial: GlobalSessionStatusStateUpdate,
  replace?: false,
): void;
function setSynchronizedState(
  partial: GlobalSessionStatusState | ((state: GlobalSessionStatusState) => GlobalSessionStatusState),
  replace: true,
): void;
function setSynchronizedState(partial: GlobalSessionStatusStateUpdate, replace?: boolean): void {
  if (partial instanceof Function) {
    if (replace === true) {
      // SAFETY: Zustand's `replace: true` overload only accepts a complete state or a complete-state updater.
      storeSetState(partial as GlobalSessionStatusState | ((state: GlobalSessionStatusState) => GlobalSessionStatusState), true);
    } else {
      storeSetState(partial, replace);
    }
    return;
  }
  if (partial.statusById === undefined || partial.activeSessionIds) {
    if (replace === true) {
      // SAFETY: Zustand's `replace: true` overload only accepts a complete state or a complete-state updater.
      storeSetState(partial as GlobalSessionStatusState, true);
    } else {
      storeSetState(partial, replace);
    }
    return;
  }

  const nextStatusById = partial.statusById;
  const current = useGlobalSessionStatusStore.getState();
  const nextActiveSessionIds = new Set<string>();
  for (const [sessionId, entry] of nextStatusById) {
    if (entry.status.type === 'busy' || entry.status.type === 'retry') {
      nextActiveSessionIds.add(sessionId);
    }
  }
  const sameMembership = nextActiveSessionIds.size === current.activeSessionIds.size
    && [...nextActiveSessionIds].every((sessionId) => current.activeSessionIds.has(sessionId));
  const nextState = {
    ...current,
    ...partial,
    activeSessionIds: sameMembership ? current.activeSessionIds : nextActiveSessionIds,
  };
  if (replace === true) storeSetState(nextState, true);
  else storeSetState(nextState, replace);
}

useGlobalSessionStatusStore.setState = setSynchronizedState;

const normalizeStatusType = (type: string | undefined): ActiveStatusType | 'idle' => {
  if (type === 'busy') return 'busy';
  if (type === 'retry') return 'retry';
  return 'idle';
};

const statusesEqual = (left: SessionStatus, right: SessionStatus): boolean => (
  left.type === right.type && JSON.stringify(left) === JSON.stringify(right)
);

// Both write paths normalize the directory key, so a polled snapshot can
// authoritatively replace entries written by events (and vice versa) even when
// the two sources format the same path differently (trailing slash, …).
const normalizeDirectory = (directory: string): string =>
  normalizeProjectPath(directory) ?? directory;

const setStatus = (sessionId: string, directory: string, status: SessionStatus | { type: 'idle' }): void => {
  useGlobalSessionStatusStore.setState((state) => {
    const current = state.statusById.get(sessionId);
    if (status.type === 'idle') {
      if (!current) return state;
      const next = new Map(state.statusById);
      next.delete(sessionId);
      const nextActiveSessionIds = new Set(state.activeSessionIds);
      nextActiveSessionIds.delete(sessionId);
      return { statusById: next, activeSessionIds: nextActiveSessionIds };
    }
    if (current && current.directory === directory && statusesEqual(current.status, status)) return state;
    const next = new Map(state.statusById);
    next.set(sessionId, { status, directory });
    if (current) return { statusById: next };
    const nextActiveSessionIds = new Set(state.activeSessionIds);
    nextActiveSessionIds.add(sessionId);
    return { statusById: next, activeSessionIds: nextActiveSessionIds };
  });
};

// Event-driven path: called by the sync dispatcher for status-bearing events
// whose directory has no child store. Mirrors the child reducer's semantics
// (`session.idle` / `session.error` both resolve to idle).
export const applyGlobalSessionStatusEvent = (directory: string, payload: Event): void => {
  switch (payload.type) {
    case 'session.status': {
      // SAFETY: OpenCode event properties for this event contain the optional session ID and status payload.
      const props = payload.properties as { sessionID?: string; status?: { type?: string } } | undefined;
      if (typeof props?.sessionID !== 'string' || !props.sessionID) return;
      const type = normalizeStatusType(props.status?.type);
      setStatus(
        props.sessionID,
        normalizeDirectory(directory),
       type === 'idle' ? { type: 'idle' } : ( // SAFETY: the normalized discriminator is busy or retry.
         { ...(props.status ?? {}), type } as SessionStatus
       ),
      );
      observeSessionActivityEvent(props.sessionID, type === 'idle' ? 'settled' : 'active');
      // `retry` is still a running turn, so the elapsed counter keeps going.
      observeSessionActivityTiming(props.sessionID, type === 'idle' ? 'settled' : 'active');
      return;
    }
    case 'session.idle':
    case 'session.error': {
      // SAFETY: OpenCode terminal event properties contain the optional addressed session ID.
      const props = payload.properties as { sessionID?: string } | undefined;
      if (typeof props?.sessionID === 'string' && props.sessionID) {
        setStatus(props.sessionID, normalizeDirectory(directory), { type: 'idle' });
        observeSessionActivityEvent(props.sessionID, 'settled');
        observeSessionActivityTiming(props.sessionID, 'settled');
      }
      return;
    }
    case 'session.deleted': {
      // SAFETY: OpenCode deletion event properties identify the deleted session directly or through info.id.
      const props = payload.properties as { sessionID?: string; info?: { id?: string } } | undefined;
      const sessionId = props?.sessionID ?? props?.info?.id;
      if (sessionId) {
        setStatus(sessionId, normalizeDirectory(directory), { type: 'idle' });
        removeSessionOrdering(sessionId);
        removeSessionActivityTiming(sessionId);
      }
      return;
    }
    default:
      return;
  }
};

// Polled path: an authoritative `/session/status?directory=X` snapshot. Entries
// missing from the snapshot are idle now — cleared both by directory key and by
// the caller's session-id list (the server may report a canonicalized directory
// that differs from the key an event wrote, e.g. via symlinks). Seeds the
// initial state (events only deliver changes) and reconciles missed events.
export const applyGlobalSessionStatusSnapshot = (
  rawDirectory: string,
  raw: Record<string, { type?: string }>,
  knownSessionIds?: Iterable<string>,
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const known = new Set(knownSessionIds ?? []);
  // Built once as a set and shared by both consumers below; only non-idle
  // sessions land here, so it stays small however long the directory's list is.
  const activeSessionIds = new Set<string>();
  for (const [sessionId, status] of Object.entries(raw)) {
    if (normalizeStatusType(status?.type) !== 'idle') activeSessionIds.add(sessionId);
  }
  reconcileSessionActivitySnapshot(activeSessionIds, known);
  // Timing asks the coverage question instead of being handed a list: a snapshot
  // authoritatively covers the caller's session list plus every id it reports
  // itself, and only the handful of sessions actually being timed need an
  // answer. Reuses the sets already built above, so this allocates nothing.
  reconcileSessionActivityTiming(
    activeSessionIds,
    (sessionId) => known.has(sessionId) || sessionId in raw,
  );
  useGlobalSessionStatusStore.setState((state) => {
    let changed = false;
    const next = new Map(state.statusById);
    let nextActiveSessionIds: Set<string> | null = null;
    const hasActiveSession = (sessionId: string): boolean => (
      (nextActiveSessionIds ?? state.activeSessionIds).has(sessionId)
    );
    const removeActiveSession = (sessionId: string): void => {
      if (!hasActiveSession(sessionId)) return;
      nextActiveSessionIds ??= new Set(state.activeSessionIds);
      nextActiveSessionIds.delete(sessionId);
    };
    const addActiveSession = (sessionId: string): void => {
      if (hasActiveSession(sessionId)) return;
      nextActiveSessionIds ??= new Set(state.activeSessionIds);
      nextActiveSessionIds.add(sessionId);
    };

    for (const [sessionId, entry] of state.statusById) {
      if ((entry.directory === directory || known.has(sessionId)) && !(sessionId in raw)) {
        next.delete(sessionId);
        removeActiveSession(sessionId);
        changed = true;
      }
    }

    for (const [sessionId, status] of Object.entries(raw)) {
      const type = normalizeStatusType(status?.type);
      const current = next.get(sessionId);
      if (type === 'idle') {
        if (current && (current.directory === directory || known.has(sessionId))) {
          next.delete(sessionId);
          removeActiveSession(sessionId);
          changed = true;
        }
        continue;
      }
      // SAFETY: normalizeStatusType has narrowed this snapshot entry to the SDK's busy/retry status discriminator.
      const normalizedStatus = { ...status, type } as SessionStatus;
      if (!current || current.directory !== directory || !statusesEqual(current.status, normalizedStatus)) {
        next.set(sessionId, { status: normalizedStatus, directory });
        if (!current) addActiveSession(sessionId);
        changed = true;
      }
    }

    return changed ? {
      statusById: next,
      activeSessionIds: nextActiveSessionIds ?? state.activeSessionIds,
    } : state;
  });
};
