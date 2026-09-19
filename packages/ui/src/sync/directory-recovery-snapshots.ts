import type { Event, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { State } from "./types"

export type DirectoryRecoverySource = { getState: () => State }

export function createSessionStatusRequestCoordinator() {
  const states = new WeakMap<DirectoryRecoverySource, { next: number; applied: number }>()
  return (owner: DirectoryRecoverySource): (() => boolean) => {
    const state = states.get(owner) ?? { next: 0, applied: 0 }
    const generation = ++state.next
    states.set(owner, state)
    // Call only at commit: a newer failed or stale request grants no authority.
    return () => {
      if (generation < state.applied) return false
      state.applied = generation
      return true
    }
  }
}

export const beginSessionStatusRequest = createSessionStatusRequestCoordinator()

type RecoveryObserver = (event: Event) => void
const observers = new WeakMap<DirectoryRecoverySource, Set<RecoveryObserver>>()

// Only in-flight reads retain events. Even a repeated busy event that produces
// no store publication must supersede an older HTTP snapshot.
export function recordDirectoryRecoveryEvent(source: DirectoryRecoverySource, event: Event): void {
  const listeners = observers.get(source)
  if (listeners) for (const listener of listeners) listener(event)
}

async function withRecoveryObserver<T>(
  source: DirectoryRecoverySource,
  observer: RecoveryObserver,
  read: () => Promise<T>,
): Promise<T> {
  let listeners = observers.get(source)
  if (!listeners) {
    listeners = new Set()
    observers.set(source, listeners)
  }
  listeners.add(observer)
  try {
    return await read()
  } finally {
    listeners.delete(observer)
    if (listeners.size === 0) observers.delete(source)
  }
}

function removedSessionID(event: Event): string | undefined {
  if (event.type === "session.deleted") return event.properties.info?.id ?? event.properties.sessionID
  if (event.type === "session.updated" && event.properties.info.time.archived) return event.properties.info.id
}

export function readDirectoryStatusSnapshot(
  source: DirectoryRecoverySource,
  read: () => Promise<State["session_status"] | null>,
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
    // Recorded no-op events protect unchanged entries, but cannot undo a newer turn.
    const current = source.getState().session_status
    for (const id of new Set([...Object.keys(before), ...Object.keys(current)])) {
      if (before[id] === current[id]) continue
      if (current[id]) snapshot[id] = current[id]
      else delete snapshot[id]
    }
    return snapshot
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
const beginQuestionRequest = createBlockingRequestCoordinator()

const indexRequests = <T extends BlockingRequest>(groups: Record<string, T[]>) => (
  new Map(Object.values(groups).flatMap((requests) => requests.map((request) => [request.id, request] as const)))
)

function readBlockingSnapshot<T extends BlockingRequest>(
  source: DirectoryRecoverySource,
  currentGroups: () => Record<string, T[]>,
  read: () => Promise<T[]>,
  mutation: (event: Event) => BlockingMutation<T> | undefined,
  authority: ReturnType<ReturnType<typeof createBlockingRequestCoordinator>>,
  options: BlockingRecoveryOptions<T>,
): Promise<Record<string, T[]>> {
  const before = indexRequests(currentGroups())
  const changes = new Map<string, T | null>()
  const removedSessions = new Set<string>()
  return withRecoveryObserver(source, (event) => {
    const change = mutation(event)
    if (change) changes.set(change.id, change.request)
    const removed = removedSessionID(event)
    if (removed) removedSessions.add(removed)
  }, async () => {
    const fetched = await read()
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
    if (options.isStale?.()) return currentGroups()
    const groups: Record<string, T[]> = {}
    for (const request of reconcile()) {
      if (settled?.has(request.id)) continue
      const group = groups[request.sessionID] ?? (groups[request.sessionID] = [])
      group.push(request)
    }
    for (const group of Object.values(groups)) group.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    // A partial recovery grants authority only to the sessions it writes.
    // Keep observing events through asynchronous preparation and this commit.
    const currentState = currentGroups()
    const merged = { ...currentState }
    const ids = options.sessionIDs ?? [...new Set([...Object.keys(currentState), ...Object.keys(groups)])]
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

export const readDirectoryQuestionSnapshot = (source: DirectoryRecoverySource, read: () => Promise<QuestionRequest[]>, options: BlockingRecoveryOptions<QuestionRequest>) => (
  readBlockingSnapshot(source, () => source.getState().question, read, (event) => {
    if (event.type === "question.asked") return { id: event.properties.id, request: event.properties }
    if (event.type === "question.replied" || event.type === "question.rejected") {
      return { id: event.properties.requestID, request: null }
    }
  }, beginQuestionRequest(source), options)
)
