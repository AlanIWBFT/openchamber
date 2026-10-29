import { create } from 'zustand';
import type { SyncEvent } from '@/lib/opencode/events';
import { readUnifiedExecMetadata } from '@/lib/opencode/tools';
import type { RunningExec } from '@/lib/opencode/exec-metadata';

export type TrackedExec = RunningExec & { id: string };

type State = { byId: ReadonlyMap<number, TrackedExec>; sessionIds: ReadonlySet<string> };
export const useRunningExecsStore = create<State>(() => ({ byId: new Map(), sessionIds: new Set() }));
let generation = 0;
let pending: Promise<void> | undefined;
let queued: Promise<void> | undefined;
const reads = new Set<Set<number>>();

function publish(byId: Map<number, TrackedExec>) {
  const previous = useRunningExecsStore.getState().sessionIds;
  const ids = new Set([...byId.values()].map((entry) => entry.sessionID));
  const sessionIds = ids.size === previous.size && [...ids].every((id) => previous.has(id)) ? previous : ids;
  useRunningExecsStore.setState({ byId, sessionIds });
}

function same(left: TrackedExec | undefined, right: RunningExec) {
  return left?.sessionID === right.sessionID && left.command === right.command && left.startedAt === right.startedAt;
}

/** Only live exec transitions feed the index; loading historical messages does not. */
export function applyRunningExecEvents(events: readonly SyncEvent[]) {
  let draft: Map<number, TrackedExec> | undefined;
  for (const event of events) {
    if (event.type !== 'message.tool.transition' || event.properties.transition.kind !== 'exec' || !event.properties.transition.live) continue;
    const { sessionID, transition } = event.properties;
    const metadata = readUnifiedExecMetadata(transition.metadata);
    const execID = metadata.execID;
    if (execID === undefined) continue;
    for (const touched of reads) touched.add(execID);
    const current = draft ?? useRunningExecsStore.getState().byId;
    if (metadata.processRunning === false) {
      if (!current.has(execID)) continue;
      draft ??= new Map(current);
      draft.delete(execID);
    } else if (metadata.processRunning === true && metadata.sessionExposed === true && metadata.command !== undefined && metadata.startedAt !== undefined) {
      const entry = { id: `exec:${execID}`, execID, sessionID, command: metadata.command, startedAt: metadata.startedAt };
      if (same(current.get(execID), entry)) continue;
      draft ??= new Map(current);
      draft.set(execID, entry);
    }
  }
  if (draft) publish(draft);
}

/** One process-wide read; concurrent events win, failed reads preserve the last live state. */
export function refreshRunningExecs(list: () => Promise<readonly RunningExec[]>): Promise<void> {
  if (pending) {
    const owner = generation;
    queued ??= pending.catch(() => undefined).then(() => {
      if (owner !== generation) return;
      queued = undefined;
      return refreshRunningExecs(list);
    });
    return queued;
  }
  const owner = generation;
  const touched = new Set<number>();
  reads.add(touched);
  const request = (async () => {
    try {
      const entries = await list();
      if (owner !== generation) return;
      const current = useRunningExecsStore.getState().byId;
      const next = new Map(current);
      const listed = new Set(entries.map((entry) => entry.execID));
      for (const id of next.keys()) if (!listed.has(id) && !touched.has(id)) next.delete(id);
      for (const entry of entries) {
        if (!touched.has(entry.execID) && !same(current.get(entry.execID), entry)) {
          next.set(entry.execID, { ...entry, id: `exec:${entry.execID}` });
        }
      }
      if (next.size !== current.size || [...next].some(([id, entry]) => current.get(id) !== entry)) publish(next);
    } finally {
      reads.delete(touched);
      if (owner === generation) pending = undefined;
    }
  })();
  pending = request;
  return request;
}

export function resetRunningExecs() {
  generation++;
  pending = undefined;
  queued = undefined;
  reads.clear();
  useRunningExecsStore.setState({ byId: new Map(), sessionIds: new Set() });
}
