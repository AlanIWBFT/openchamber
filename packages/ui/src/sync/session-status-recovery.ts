import type { StoreApi } from "zustand"
import type { SessionStatus } from "@/lib/opencode/model"
import { type DirectoryStore } from "./child-store"
import { runBackgroundNetworkTask } from "@/lib/background-network"
import { beginSessionStatusRequest, readDirectoryStatusSnapshot } from "./directory-recovery-snapshots"
import { hasPromptInFlight } from "./prompts-in-flight"
import { getReconnectCandidateSessionIds } from "./reconnect-recovery"
import { opencodeClient } from "@/lib/opencode/client"
import { applyGlobalSessionStatusSnapshot, getDirectoryOwnedSessionIds } from "./global-session-status"
import { markRecordedInterruptedTurn } from "./interrupted-turn-recovery"
import { getViewedSessionMaterializationTarget } from "./viewed-sessions"

const syncSnapshotSignature = (value: unknown): string => JSON.stringify(value)

function haveEquivalentSyncSnapshots(left: unknown, right: unknown): boolean {
  return syncSnapshotSignature(left) === syncSnapshotSignature(right)
}

export const statusPollingDirectories = new Set<string>()

const pendingMessageCompletionPolls = new Map<string, ReturnType<typeof setTimeout>>()

export const MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS = 750

const toSessionStatus = (status: SessionStatus | undefined): SessionStatus | undefined => status

export function getActiveSessionCandidateIds(directory: string, state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state, {
    directory,
    viewedSession: getViewedSessionMaterializationTarget(directory),
  })
}

export function getLiveSessionCandidateIds(state: DirectoryStore): string[] {
  return getReconnectCandidateSessionIds(state)
}

type DirectorySessionStatusSnapshot = NonNullable<
  Awaited<ReturnType<typeof opencodeClient.getActiveSessionStatuses>>
>

type StatusSnapshotMode = "monotonic" | "authoritative"

export function applySessionStatusSnapshot(
  store: StoreApi<DirectoryStore>,
  snapshot: DirectorySessionStatusSnapshot,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
): boolean {
  let changed = false
  store.setState((state: DirectoryStore) => {
    const current = state.session_status ?? {}
    let next: Record<string, SessionStatus> | undefined
    let nextInvalidated: Record<string, true> | undefined
    const draft = () => (next ??= { ...current })

    if (!state.sessionStatusReady) {
      changed = true
    }

    for (const [sessionId, rawStatus] of Object.entries(snapshot)) {
      const incoming = toSessionStatus(rawStatus)
      if (!incoming || incoming.type === "idle") continue
      const held = current[sessionId]
      if (incoming.type === "busy" && held?.type === "retry" && (held.next === undefined || held.next > Date.now())) continue
      if (!haveEquivalentSyncSnapshots(current[sessionId], incoming)) {
        draft()[sessionId] = incoming
        changed = true
      }
    }

    for (const sessionId of candidateSessionIds) {
      const incoming = toSessionStatus(snapshot[sessionId])
      if (mode === "authoritative" && state.sessionStatusInvalidated?.[sessionId]) {
        nextInvalidated ??= { ...state.sessionStatusInvalidated }
        delete nextInvalidated[sessionId]
        changed = true
      }

      if (incoming && incoming.type !== "idle") {
        continue
      }

      if (hasPromptInFlight(sessionId)) continue

      const existing = current[sessionId]
      if (mode === "monotonic" && existing) continue

      if (existing?.type !== "idle") {
        draft()[sessionId] = { type: "idle" }
        changed = true
      }
    }

    if (!next && !nextInvalidated && state.sessionStatusReady) return state
    const patch: Partial<DirectoryStore> = { sessionStatusReady: true }
    if (next) patch.session_status = next
    if (nextInvalidated) patch.sessionStatusInvalidated = nextInvalidated
    return patch
  })

  return changed
}

export async function resyncDirectorySessionStatuses(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds: string[],
  mode: StatusSnapshotMode,
  isStale?: () => boolean,
): Promise<DirectorySessionStatusSnapshot | null> {
  const invalidatedAtStart = store.getState().sessionStatusInvalidated
  const isCurrentRequest = beginSessionStatusRequest(store)
  return readDirectoryStatusSnapshot(store, () => opencodeClient.getActiveSessionStatuses(directory), (nextStatuses) => {
    if (isStale?.() || !isCurrentRequest()) return false
    const current = store.getState()
    const currentInvalidated = current.sessionStatusInvalidated
    const known = new Set(current.session.map((session) => session.id))
    const owned = new Set(getDirectoryOwnedSessionIds(directory, current.session))
    const eligibleIds = candidateSessionIds.filter((id) => (
      (!currentInvalidated?.[id] || currentInvalidated === invalidatedAtStart) && (!known.has(id) || owned.has(id))
    ))
    const scoped = new Set([...owned, ...eligibleIds])
    const scopedStatuses = Object.fromEntries(Object.entries(nextStatuses).filter(([id]) => scoped.has(id)))
    const retained = Object.fromEntries(Object.entries(current.session_status).filter(([id]) => !known.has(id) || owned.has(id)))
    if (Object.keys(retained).length !== Object.keys(current.session_status).length) store.setState({ session_status: retained })
    applySessionStatusSnapshot(store, scopedStatuses, eligibleIds, mode)
    if (mode === "authoritative") {
      store.setState({ sessionStatusReady: true })
      const ownedStatuses = Object.fromEntries(Object.entries(scopedStatuses).filter(([id]) => owned.has(id)))
      applyGlobalSessionStatusSnapshot(directory, ownedStatuses, [...owned])
      for (const sessionId of eligibleIds) {
        markRecordedInterruptedTurn(store, sessionId)
      }
    }
    return true
  })
}

export function maybePollStatusAfterMessageCompletion(
  directory: string,
  store: StoreApi<DirectoryStore>,
  sessionID: string,
): void {
  if (!directory || directory === "global" || !sessionID) return
  const current = store.getState().session_status?.[sessionID]
  if (!current || current.type === "idle") return

  const pendingKey = `${directory}\u0000${sessionID}`
  if (pendingMessageCompletionPolls.has(pendingKey)) return

  const timer = setTimeout(() => {
    pendingMessageCompletionPolls.delete(pendingKey)
    const latest = store.getState().session_status?.[sessionID]
    if (!latest || latest.type === "idle") return
    if (statusPollingDirectories.has(directory)) return

    statusPollingDirectories.add(directory)
    void (async () => {
      try {
        const statuses = await runBackgroundNetworkTask(() =>
          resyncDirectorySessionStatuses(directory, store, [sessionID], "monotonic"), "active-session")
        if (!statuses) return
        if (needsSnapshotAfterStatusPoll(store.getState(), sessionID, statuses[sessionID])) {
          await runBackgroundNetworkTask(() =>
            resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative"), "active-session")
        }
      } catch {
        // Best-effort — the watchdog poll retries on its own cadence.
      } finally {
        statusPollingDirectories.delete(directory)
      }
    })()
  }, MESSAGE_COMPLETION_STATUS_POLL_DELAY_MS)

  pendingMessageCompletionPolls.set(pendingKey, timer)
}

export function needsSnapshotAfterStatusPoll(
  state: DirectoryStore,
  sessionId: string,
  snapshotEntry: DirectorySessionStatusSnapshot[string] | undefined,
): boolean {
  const incoming = toSessionStatus(snapshotEntry)
  if (incoming && incoming.type !== "idle") return false
  if (hasPromptInFlight(sessionId)) return false
  const currentStatus = state.session_status?.[sessionId]
  return Boolean(currentStatus && currentStatus.type !== "idle")
}
