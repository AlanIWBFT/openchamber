import type { SyncEvent } from "@/lib/opencode/events"
import type { FormRequest, PermissionRequest, SessionStatus } from "@/lib/opencode/model"
import type { State } from "./types"

export type DirectoryRecoverySource = { getState: () => State }

export function createSessionStatusRequestCoordinator() {
  const states = new WeakMap<DirectoryRecoverySource, { next: number; applied: number }>()
  return (owner: DirectoryRecoverySource): (() => boolean) => {
    const state = states.get(owner) ?? { next: 0, applied: 0 }
    const generation = ++state.next
    states.set(owner, state)
    // Only a successfully committed response supersedes an older request.
    return () => {
      if (generation < state.applied) return false
      state.applied = generation
      return true
    }
  }
}

export const beginSessionStatusRequest = createSessionStatusRequestCoordinator()

type RecoveryObserver = (event: SyncEvent) => void
const observers = new WeakMap<DirectoryRecoverySource, Set<RecoveryObserver>>()

// Only in-flight reads retain events. Even a repeated busy event that produces
// no store publication must supersede an older HTTP snapshot.
export function recordDirectoryRecoveryEvent(source: DirectoryRecoverySource, event: SyncEvent): void {
  const listeners = observers.get(source)
  if (listeners) for (const listener of listeners) listener(event)
}

export function observeDirectoryRecoveryEvents(
  source: DirectoryRecoverySource,
  observer: RecoveryObserver,
): () => void {
  let listeners = observers.get(source)
  if (!listeners) {
    listeners = new Set()
    observers.set(source, listeners)
  }
  listeners.add(observer)
  return () => {
    listeners.delete(observer)
    if (listeners.size === 0 && observers.get(source) === listeners) observers.delete(source)
  }
}

async function withRecoveryObserver<T>(
  source: DirectoryRecoverySource,
  observer: RecoveryObserver,
  read: () => Promise<T>,
): Promise<T> {
  const release = observeDirectoryRecoveryEvents(source, observer)
  try {
    return await read()
  } finally {
    release()
  }
}

function removedSessionID(event: SyncEvent): string | undefined {
  if (event.type === "session.deleted") return event.properties.sessionID
  if (event.type === "session.patched" && event.properties.patch.time?.archived) return event.properties.sessionID
}

export function readDirectoryStatusSnapshot(
  source: DirectoryRecoverySource,
  read: () => Promise<State["session_status"]>,
): Promise<State["session_status"]>
export function readDirectoryStatusSnapshot(
  source: DirectoryRecoverySource,
  read: () => Promise<State["session_status"] | null>,
  commit?: (snapshot: State["session_status"]) => boolean,
): Promise<State["session_status"] | null>
export function readDirectoryStatusSnapshot(
  source: DirectoryRecoverySource,
  read: () => Promise<State["session_status"] | null>,
  commit?: (snapshot: State["session_status"]) => boolean,
): Promise<State["session_status"] | null> {
  const before = source.getState().session_status
  const changes = new Map<string, SessionStatus | null>()
  return withRecoveryObserver(source, (event) => {
    if (event.type === "session.status") changes.set(event.properties.sessionID, event.properties.status)
    else if (event.type === "session.idle" || event.type === "session.error") {
      if (event.properties.sessionID) changes.set(event.properties.sessionID, { type: "idle" })
    }
    const removed = removedSessionID(event)
    if (removed) changes.set(removed, null)
  }, async () => {
    const fetched = await read()
    if (fetched === null) return null
    const snapshot = { ...fetched }
    for (const [id, status] of changes) {
      if (status) snapshot[id] = status
      else delete snapshot[id]
    }
    // The store includes accepted events and subsequent optimistic mutations.
    // No-op events protect unchanged entries, but cannot undo a newer turn.
    const current = source.getState().session_status
    for (const id of new Set([...Object.keys(before), ...Object.keys(current)])) {
      if (before[id] === current[id]) continue
      if (current[id]) snapshot[id] = current[id]
      else delete snapshot[id]
    }
    // Reconcile and publish without yielding; keep observing until publication.
    return !commit || commit(snapshot) ? snapshot : null
  })
}

type BlockingRequest = { id: string; sessionID: string }
type BlockingMutation<T> = { id: string; request: T | null }
type BlockingRecoveryOptions<T> = {
  sessionIDs?: readonly string[]
  isStale?: () => boolean
  settle?: (requests: T[]) => Promise<ReadonlySet<string>>
  commit: (groups: Record<string, T[]>) => void
}

function createBlockingRequestCoordinator() {
  const owners = new WeakMap<DirectoryRecoverySource, { next: number; full: number; sessions: Map<string, number> }>()
  return (source: DirectoryRecoverySource) => {
    const owner = owners.get(source) ?? { next: 0, full: 0, sessions: new Map<string, number>() }
    owners.set(source, owner)
    const generation = ++owner.next
    return {
      accepts: (id: string) => generation >= Math.max(owner.full, owner.sessions.get(id) ?? 0),
      applied: (ids: readonly string[] | undefined) => {
        if (ids) {
          for (const id of ids) owner.sessions.set(id, Math.max(generation, owner.sessions.get(id) ?? 0))
        } else {
          owner.full = Math.max(owner.full, generation)
          for (const [id, applied] of owner.sessions) if (applied <= owner.full) owner.sessions.delete(id)
        }
      },
    }
  }
}
const beginPermissionRequest = createBlockingRequestCoordinator()
const beginFormRequest = createBlockingRequestCoordinator()

const indexRequests = <T extends BlockingRequest>(groups: Record<string, T[]>) => (
  new Map(Object.values(groups).flatMap((requests) => requests.map((request) => [request.id, request] as const)))
)

function readBlockingSnapshot<T extends BlockingRequest>(
  source: DirectoryRecoverySource,
  currentGroups: () => Record<string, T[]>,
  read: () => Promise<T[]>,
  mutation: (event: SyncEvent) => BlockingMutation<T> | undefined,
  authority: ReturnType<ReturnType<typeof createBlockingRequestCoordinator>>,
  options: BlockingRecoveryOptions<T>,
): Promise<Record<string, T[]>> {
  const before = indexRequests(currentGroups())
  const changes = new Map<string, T | null>()
  const removedSessions = new Set<string>()
  let invalidated = false
  return withRecoveryObserver(source, (event) => {
    if (event.type === "location.shutdown") invalidated = true
    const change = mutation(event)
    if (change) changes.set(change.id, change.request)
    const removed = removedSessionID(event)
    if (removed) removedSessions.add(removed)
  }, async () => {
    const fetched = await read()
    if (invalidated) throw new Error("Location recovery invalidated")
    if (options.isStale?.()) return currentGroups()
    const reconcile = () => {
      const snapshot = new Map(fetched.filter((request) => request.id && request.sessionID).map((request) => [request.id, request]))
      const current = indexRequests(currentGroups())
      for (const id of before.keys()) if (!current.has(id)) snapshot.delete(id)
      for (const [id, request] of current) if (before.get(id) !== request) snapshot.set(id, request)
      for (const [id, request] of changes) {
        if (request) snapshot.set(id, request)
        else snapshot.delete(id)
      }
      return [...snapshot.values()].filter((request) => !removedSessions.has(request.sessionID))
    }
    const settled = options.settle ? await options.settle(reconcile()) : undefined
    if (invalidated) throw new Error("Location recovery invalidated")
    if (options.isStale?.()) return currentGroups()
    const groups: Record<string, T[]> = {}
    for (const request of reconcile()) {
      if (settled?.has(request.id)) continue
      const group = groups[request.sessionID] ?? (groups[request.sessionID] = [])
      group.push(request)
    }
    for (const group of Object.values(groups)) group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const current = currentGroups()
    const merged = { ...current }
    const ids = options.sessionIDs ?? [...new Set([...Object.keys(current), ...Object.keys(groups)])]
    for (const id of ids) {
      if (!authority.accepts(id)) continue
      if (groups[id]) merged[id] = groups[id]
      else delete merged[id]
    }
    authority.applied(options.sessionIDs)
    options.commit(merged)
    return merged
  })
}

export const readDirectoryPermissionSnapshot = (source: DirectoryRecoverySource, read: () => Promise<PermissionRequest[]>, options: BlockingRecoveryOptions<PermissionRequest>) => (
  readBlockingSnapshot(source, () => source.getState().permission, read, (event) => {
    if (event.type === "permission.asked") return { id: event.properties.id, request: event.properties }
    if (event.type === "permission.replied") return { id: event.properties.requestID, request: null }
  }, beginPermissionRequest(source), options)
)

export const readDirectoryFormSnapshot = (source: DirectoryRecoverySource, read: () => Promise<FormRequest[]>, options: BlockingRecoveryOptions<FormRequest>) => (
  readBlockingSnapshot(source, () => source.getState().form, read, (event) => {
    if (event.type === "form.created") return { id: event.properties.form.id, request: event.properties.form }
    if (event.type === "form.settled") {
      return { id: event.properties.formID, request: null }
    }
  }, beginFormRequest(source), options)
)
