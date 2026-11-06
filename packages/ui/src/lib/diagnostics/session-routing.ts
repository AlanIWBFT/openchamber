import { writeDesktopRoutingDiagnostic } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { generateUuid } from '@/lib/uuid';
import type { ModelRef } from '@/lib/opencode/model';
import { formatDiagnosticEvents, getDiagnosticEvents, recordDiagnosticEvent } from './timeline';

type RoutingAction = 'store-add' | 'store-remove' | 'store-change' | 'cache-read' | 'cache-write' | 'cache-queue'
  | 'fetch-start' | 'fetch-result' | 'bootstrap-page' | 'bootstrap-complete' | 'index-replace' | 'event-route'
  | 'select' | 'send-selection' | 'send-route' | 'model-switch' | 'model-cache-mismatch' | 'move';
type RoutingSource = 'restore' | 'store' | 'reactive' | 'reconnect' | 'bootstrap' | 'event-index' | 'send-index'
  | 'event' | 'selection' | 'send' | 'pending' | 'v2' | 'legacy' | 'move-request' | 'move-event';

export type SessionRoutingObservation = {
  action: RoutingAction;
  source: RoutingSource;
  eventType?: 'session.created' | 'session.patched' | 'session.deleted';
  runtimeKey?: string;
  sessionId?: string;
  directory?: string | null;
  ownerDirectory?: string | null;
  previousDirectory?: string | null;
  cacheKey?: string;
  request?: number;
  count?: number;
  revision?: number;
  updated?: number;
  previousUpdated?: number;
  model?: ModelRef | null;
  previousModel?: ModelRef | null;
  cachedModel?: ModelRef | null;
  outcome?: 'accepted' | 'stale' | 'failed' | 'switch' | 'unchanged' | 'started' | 'completed';
  guessed?: boolean;
  captureSite?: boolean;
};

// Labels belong to one page lifetime. The page ID keeps a reload or another
// window's labels distinct in the desktop file, where earlier events survive.
const page = generateUuid();
const identities = new Map<string, string>();
let nextIdentity = 0;
let sequence = 0;
let windowStarted = 0;
let windowCount = 0;
let omitted = 0;
type ModelCacheIncident = { reference: string; text: string };
const incidentListeners = new Set<(incident: ModelCacheIncident) => void>();
const reportedMismatches = new Set<string>();

export const subscribeModelCacheIncidents = (listener: (incident: ModelCacheIncident) => void): (() => void) => {
  incidentListeners.add(listener);
  return () => { incidentListeners.delete(listener); };
};

/** Rearm only after a server read confirms the cached models agree again. */
export function reportModelCacheMismatch(observation: Omit<SessionRoutingObservation, 'action' | 'source'> & { sessionId: string }, suppressed: boolean, consistent: boolean): void {
  const key = `${getRuntimeKey()}\0${observation.sessionId}`;
  if (consistent) { reportedMismatches.delete(key); return; }
  if (!suppressed || reportedMismatches.has(key)) return;
  if (reportedMismatches.size >= 200) reportedMismatches.delete(reportedMismatches.values().next().value!);
  reportedMismatches.add(key);
  const seq = recordSessionRouting({ ...observation, action: 'model-cache-mismatch', source: 'send', outcome: 'switch' });
  const reference = `${page}:${seq}`;
  const incident = { reference, text: `Session routing incident ${reference}\n\n${formatDiagnosticEvents(getDiagnosticEvents().slice(-200))}` };
  for (const listener of incidentListeners) {
    try { listener(incident); } catch { /* A notification cannot stop the send. */ }
  }
}

const identity = (kind: 'runtime' | 'session' | 'directory' | 'cache' | 'model', value: string, runtime: string): string => {
  const key = `${runtime}\0${kind}\0${value}`;
  const known = identities.get(key);
  if (known) return known;
  const label = `${kind}-${++nextIdentity}`;
  if (identities.size >= 5_000) identities.delete(identities.keys().next().value!);
  identities.set(key, label);
  return label;
};

const routingDirectoryKey = (directory: string): string => {
  const normalized = directory.replace(/\\/g, '/').replace(/\/$/, '');
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized;
};

/** Console-only diagnostics can correlate a real session with its file labels. */
export const getSessionRoutingIdentity = (sessionId: string, directory?: string | null) => {
  const runtime = getRuntimeKey();
  return {
    page,
    runtime: identity('runtime', runtime, runtime),
    session: identity('session', sessionId, runtime),
    directory: directory ? identity('directory', routingDirectoryKey(directory), runtime) : null,
  };
};

const modelLabel = (model: ModelRef | null | undefined, runtime: string): string | null => {
  if (!model) return null;
  const value = `${model.providerID}/${model.id}#${model.variant ?? 'default'}`;
  return identity('model', value, runtime);
};

/** Fixed fields only: titles, paths, IDs, API bodies and raw stacks never reach a sink. */
export function recordSessionRouting(observation: SessionRoutingObservation): number {
  const seq = ++sequence;
  try {
    const runtime = observation.runtimeKey ?? getRuntimeKey();
    // An async result keeps its request's owner. Never append it to another
    // runtime's timeline or use the new runtime's desktop-file permission.
    if (runtime !== getRuntimeKey()) return seq;
    const at = Date.now();
    if (at - windowStarted >= 1_000) {
      windowStarted = at;
      windowCount = 0;
    }
    if (++windowCount > 200 && observation.action !== 'model-cache-mismatch') { omitted++; return seq; }
    const directory = (value: string | null | undefined) => value ? identity('directory', routingDirectoryKey(value), runtime) : null;
    const event = {
      page, seq, at, runtime: identity('runtime', runtime, runtime),
      action: observation.action, source: observation.source, eventType: observation.eventType,
      session: observation.sessionId ? identity('session', observation.sessionId, runtime) : undefined,
      directory: directory(observation.directory), owner: directory(observation.ownerDirectory), previousDirectory: directory(observation.previousDirectory),
      cache: observation.cacheKey ? identity('cache', observation.cacheKey, runtime) : undefined,
      request: observation.request, count: observation.count, revision: observation.revision,
      updated: observation.updated, previousUpdated: observation.previousUpdated,
      model: modelLabel(observation.model, runtime), previousModel: modelLabel(observation.previousModel, runtime), cachedModel: modelLabel(observation.cachedModel, runtime),
      outcome: observation.outcome, guessed: observation.guessed,
      sites: observation.captureSite ? [...(new Error().stack ?? '').matchAll(/\b([A-Za-z0-9_-]+\.(?:js|mjs|tsx?))(?:\?[^\s):]*)?:(\d+):(\d+)/g)]
        .slice(0, 8).map((match) => `${match[1]}:${match[2]}:${match[3]}`) : undefined,
      omitted: omitted || undefined,
    };
    omitted = 0;
    const serialized = JSON.stringify(event);
    recordDiagnosticEvent({ at, source: 'session-routing', action: observation.action, detail: serialized });
    writeDesktopRoutingDiagnostic(serialized);
  } catch { /* Diagnostics never interrupt a store write or a send. */ }
  return seq;
}

type RoutingRecord = { id: string; directory?: string; model?: ModelRef; time?: { updated: number } };
const sameModel = (left?: ModelRef, right?: ModelRef): boolean => left?.id === right?.id && left?.providerID === right?.providerID && left?.variant === right?.variant;

/** Session lists are ID-sorted. Ignore token/cost/time-only changes on the stream path. */
export function observeSessionRouting(directory: string, next: readonly RoutingRecord[], previous: readonly RoutingRecord[], source: 'restore' | 'store'): void {
  if (next === previous) return;
  const owner = routingDirectoryKey(directory);
  let before = 0;
  const removed = (session: RoutingRecord) => {
    if (!session.directory || routingDirectoryKey(session.directory) === owner) return;
    recordSessionRouting({ action: 'store-remove', source, sessionId: session.id, directory, ownerDirectory: session.directory, model: session.model, captureSite: true });
  };
  for (const session of next) {
    while (before < previous.length && previous[before]!.id < session.id) removed(previous[before++]!);
    const old = previous[before]?.id === session.id ? previous[before] : undefined;
    if (old) before++;
    if (old === session || !session.directory) continue;
    const foreign = routingDirectoryKey(session.directory) !== owner;
    if (!old && !foreign) continue;
    if (old && old.directory === session.directory && sameModel(old.model, session.model)) continue;
    recordSessionRouting({
      action: old ? 'store-change' : 'store-add', source, sessionId: session.id, directory, ownerDirectory: session.directory,
      previousDirectory: old?.directory, model: session.model, previousModel: old?.model, updated: session.time?.updated, previousUpdated: old?.time?.updated,
      captureSite: foreign,
    });
  }
  while (before < previous.length) removed(previous[before++]!);
}
