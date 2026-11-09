import type { StoreApi } from "zustand"
import { type SessionMaterializationReason } from "./event-reducer"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { retry } from "./retry"
import { hasPromptInFlight } from "./prompts-in-flight"
import { stripSessionDiffSnapshots } from "./sanitize"
import { upsertSessionRecord } from "./session-records"
import { syncDebug } from "./debug"
import { opencodeClient } from "@/lib/opencode/client"
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { isSpaceDirectory } from "@/lib/spaces/space-route"
import { normalizePath } from "@/lib/pathNormalization"
import { adoptSessionMove } from "./session-actions"
import { applyGlobalSessionStatusEvents, buildActiveListReconcileEvents, watchGlobalSessionStatusWrites } from "./global-session-status"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { type EventRoutingIndex, setIndexedSessionDirectory, setIndexedSessionMessages, ingestDirectoryStateIntoRoutingIndex } from "./event-routing-index"
import { getActiveSessionCandidateIds, resyncDirectorySessionStatuses } from "./session-status-recovery"
import { markRecordedInterruptedTurn } from "./interrupted-turn-recovery"
import { resyncBlockingRequestsForDirectory } from "./blocking-request-recovery"
import { isCatalogRuntimeCurrent } from "./sync-catalog-refresh"

const RECONNECT_MESSAGE_LIMIT = 30

export async function resyncDirectoryAfterReconnect(
  directory: string,
  store: StoreApi<DirectoryStore>,
  routingIndex: EventRoutingIndex,
  reason: SessionMaterializationReason,
  isStale: () => boolean,
) {
  if (isStale()) return
  const current = store.getState()
  const previous = getActiveSessionCandidateIds(directory, current)

  const statuses = await resyncDirectorySessionStatuses(directory, store, previous, "authoritative", isStale)
  let succeeded = statuses !== null
  if (isStale()) return
  const candidateSessionIds = [...new Set([...previous, ...getActiveSessionCandidateIds(directory, store.getState())])]
  if (!candidateSessionIds.length) return succeeded

  if (reason !== "stream-replayed") await Promise.all(candidateSessionIds.map(async (sessionId) => {
    syncDebug.recovery.materializing({ reason, directory, sessionID: sessionId })
    const revision = store.getState().sessionRevision ?? 0
    const staleSession = () => isStale() || (store.getState().sessionDeletedRevision?.[sessionId] ?? 0) > revision
    const loader = getImperativeSessionMessageLoader()
    const session = await retry(() => opencodeClient.getSession(sessionId, directory)).catch(() => null)
    if (staleSession()) return
    if (!session) { succeeded = false; return }
    if (normalizePath(directory) !== normalizePath(session.directory)) {
      useGlobalSessionsStore.getState().upsertSession(session)
      adoptSessionMove(sessionId, directory, session.directory)
      return
    }
    await loader?.refreshTail({ directory, sessionID: sessionId }, RECONNECT_MESSAGE_LIMIT)
    if (staleSession()) return
    if (loader?.getSnapshot({ directory, sessionID: sessionId }).status === "error") succeeded = false
    markRecordedInterruptedTurn(store, sessionId)

    const nextSession = stripSessionDiffSnapshots(session)
    store.setState((state: DirectoryStore) => {
      if ((state.sessionEventRevision?.[sessionId] ?? 0) > revision) return state
      const sessions = upsertSessionRecord(state.session, nextSession)
      let sessionTotal = state.sessionTotal

      if (sessions === state.session) {
        return state
      }
      if (!state.session.some((item) => item.id === nextSession.id) && !nextSession.parentID) sessionTotal += 1

      return {
        session: sessions,
        sessionTotal,
      }
    })

    setIndexedSessionDirectory(routingIndex, nextSession.id, directory)
    setIndexedSessionMessages(routingIndex, sessionId, directory, store.getState().message[sessionId] ?? [])
  }))

  if (isStale()) return
  const remaining = candidateSessionIds.filter((id) => !store.getState().sessionDeletedRevision?.[id])
  const blockingRequestsSucceeded = await resyncBlockingRequestsForDirectory(directory, store, remaining, {
    isStale: () => isStale() || remaining.some((id) => Boolean(store.getState().sessionDeletedRevision?.[id])),
  })

  if (isStale()) return
  ingestDirectoryStateIntoRoutingIndex(routingIndex, directory, store.getState())
  return succeeded && blockingRequestsSucceeded
}

export async function reconcileActivityAfterGap(childStores: ChildStoreManager): Promise<void> {
  const runtime = { key: getRuntimeKey(), sdk: opencodeClient.getSdkClient() }
  const writes = watchGlobalSessionStatusWrites()
  try {
    const active = await opencodeClient.getActiveSessionStatuses()
    if (!active || !isCatalogRuntimeCurrent(runtime)) return
    const activeSessionIds = new Set(Object.keys(active))
    const events = buildActiveListReconcileEvents(activeSessionIds, {
      skip: (sessionId) => writes.touched.has(sessionId) || hasPromptInFlight(sessionId),
      covers: (directory) => !isSpaceDirectory(directory),
      resolveDirectory: (sessionId) => {
        const session = useGlobalSessionsStore.getState().entityById.get(sessionId)
        return session ? resolveGlobalSessionDirectory(session) : null
      },
    })
    for (const [directory, payloads] of events) applyGlobalSessionStatusEvents(directory, payloads)
    childStores.refreshStaleDirectoriesWithActiveSessions(activeSessionIds)
  } finally {
    writes.stop()
  }
}
