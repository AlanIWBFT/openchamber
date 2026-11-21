import type { StoreApi } from "zustand"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { countSyncPerformance } from "./performance-diagnostics"
import { syncDebug } from "./debug"
import { opencodeClient } from "@/lib/opencode/client"
import { isSessionMaterializationStillNeeded, type SessionMaterializationRequest } from "./materialization"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getImperativeSessionMessageLoader } from "./session-message-loader"
import { directorySessionMovedTo } from "./event-routing-index"
import { resyncDirectorySessionStatuses } from "./session-status-recovery"
import { recoverMessageOrder } from "./message-order-recovery"
import { markRecordedInterruptedTurn } from "./interrupted-turn-recovery"

const SESSION_MATERIALIZATION_MESSAGE_LIMIT = 30

type PendingSessionMaterialization = {
  sessionID: string
  directory: string
  enqueuedAt: number
  request: SessionMaterializationRequest
}

const SESSION_MATERIALIZATION_COOLDOWN_MS = 5_000
const pendingSessionMaterializationsByStore = new WeakMap<StoreApi<DirectoryStore>, Map<string, PendingSessionMaterialization>>()

const getPendingSessionMaterializations = (store: StoreApi<DirectoryStore>) => {
  const existing = pendingSessionMaterializationsByStore.get(store)
  if (existing) return existing
  const created = new Map<string, PendingSessionMaterialization>()
  pendingSessionMaterializationsByStore.set(store, created)
  return created
}

export function enqueueSessionMaterialization(
  directory: string,
  sessionID: string,
  childStores: ChildStoreManager,
  request: SessionMaterializationRequest,
) {
  if (!directory || directory === "global" || !sessionID) return
  const store = childStores.getChild(directory)
  if (!store) return
  const pending = getPendingSessionMaterializations(store)
  const orderRecovery = request.reason === "missing-message-sequence" || request.reason === "missing-compaction-record"
  const requestKey = orderRecovery ? JSON.stringify([sessionID, request.messageID]) : sessionID
  const existing = pending.get(requestKey)
  if (existing && (orderRecovery || Date.now() - existing.enqueuedAt < SESSION_MATERIALIZATION_COOLDOWN_MS)) {
    const settlementMustFollowEarlierRecovery = request.reason === "settled-running-tool"
      && existing.request.reason !== "settled-running-tool"
    if (!settlementMustFollowEarlierRecovery) return
  }

  const entry = { sessionID, directory, enqueuedAt: Date.now(), request }
  pending.set(requestKey, entry)
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const isStale = () => pending.get(requestKey) !== entry || childStores.getChild(directory) !== store
    || getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== sdk
  countSyncPerformance("materializationEnqueues")
  if (request.reason === "empty-assistant-message") {
    countSyncPerformance("materializationEmptyAssistantEnqueues")
  } else if (request.reason === "missing-owning-message") {
    countSyncPerformance("materializationMissingMessageEnqueues")
  } else if (request.reason === "orphan-delta" || request.reason === "missing-delta-part") {
    countSyncPerformance("materializationMissingPartEnqueues")
  } else {
    countSyncPerformance("materializationLifecycleEnqueues")
  }

  const run = async () => {
    if (isStale()) {
      if (pending.get(requestKey) === entry) pending.delete(requestKey)
      return
    }
    try {
      const movedTo = directorySessionMovedTo(store.getState(), directory, sessionID)
      if (movedTo) {
        if (childStores.getChild(movedTo)) enqueueSessionMaterialization(movedTo, sessionID, childStores, request)
        return
      }
      if (!isSessionMaterializationStillNeeded(store.getState(), sessionID, request)) {
        countSyncPerformance("materializationPreflightSkips")
        return
      }
      countSyncPerformance("materializationRequests")
      await materializeSessionFromServer(directory, sessionID, store, {
        ...request,
        isStale,
      })
    } catch {
      return
    } finally {
      const remainingCooldown = SESSION_MATERIALIZATION_COOLDOWN_MS - (Date.now() - entry.enqueuedAt)
      if (orderRecovery || remainingCooldown <= 0) {
        if (pending.get(requestKey) === entry) pending.delete(requestKey)
      } else {
        setTimeout(() => {
          if (pending.get(requestKey) === entry) pending.delete(requestKey)
        }, remainingCooldown)
      }
    }
  }

  void Promise.resolve().then(run)
}

async function materializeSessionFromServer(
  directory: string,
  sessionID: string,
  store: StoreApi<DirectoryStore>,
  options?: SessionMaterializationRequest & { isStale?: () => boolean },
) {
  const runtimeKey = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const isStale = () => options?.isStale?.() || getRuntimeKey() !== runtimeKey
    || opencodeClient.getSdkClient() !== sdk
  const statusBeforeMaterialization = store.getState().session_status?.[sessionID]
  syncDebug.recovery.materializing({
    reason: options?.reason ?? "ensure-session-messages",
    directory,
    sessionID,
    messageID: options?.messageID,
    partID: options?.partID,
  })
  const loader = getImperativeSessionMessageLoader()
  if (!loader || isStale()) return
  if (options?.messageID && (options.reason === "missing-message-sequence" || options.reason === "missing-compaction-record")) {
    const target = { directory, sessionID }
    const generation = loader.getSnapshot(target).generation
    await recoverMessageOrder({
      source: store,
      reader: opencodeClient,
      directory,
      sessionID,
      messageID: options.messageID,
      compactionEventSeq: options.compactionEventSeq,
      isCurrent: () => !isStale() && getImperativeSessionMessageLoader() === loader && loader.getSnapshot(target).generation === generation,
    })
    return
  }
  await loader.refreshTail({ directory, sessionID }, SESSION_MATERIALIZATION_MESSAGE_LIMIT)
  if (isStale()) return
  if (loader.getSnapshot({ directory, sessionID }).status === "error") {
    throw loader.getSnapshot({ directory, sessionID }).error ?? new Error("Session materialization failed")
  }

  if (statusBeforeMaterialization && statusBeforeMaterialization.type !== "idle" && !isStale()) {
    await resyncDirectorySessionStatuses(directory, store, [sessionID], "authoritative", isStale)
  }
  if (!isStale()) {
    markRecordedInterruptedTurn(store, sessionID)
  }
}
