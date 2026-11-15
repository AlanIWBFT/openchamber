import { afterEach, expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import type { Session } from "@/lib/opencode/model"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { ChildStoreManager } from "../child-store"
import { setActionRefs } from "../session-actions"
import { setSyncRefs } from "../sync-refs"
import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from "../global-session-status"
import { directoryUse } from "../location-release"
import { applyGlobalBlockingRequestSnapshot, useGlobalBlockingRequestsStore } from "../global-blocking-requests"
import { SessionMessageLoader, setImperativeSessionMessageLoader } from "../session-message-loader"
import { createEventRoutingIndex, handleEvent } from "../sync-context"
import { resyncDirectoryAfterReconnect } from "../session-reconnect-recovery"

const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup() })
let run = 0

function session(id: string, directory: string): Session {
  return { id, directory, projectID: "project", title: id, time: { created: 1, updated: 1 }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
}

function setup(onMessages?: () => void) {
  const directory = `/reconnect-ownership-${++run}`
  const own = session(`ses_own_${run}`, directory)
  const other = session(`ses_other_${run}`, `${directory}-other`)
  const manager = new ChildStoreManager()
  setActionRefs(manager, () => directory)
  const store = manager.ensureChild(directory, { bootstrap: false })
  store.setState({ session: [own], sessionTotal: 1 })
  const messageReads: string[] = []
  const loader = new SessionMessageLoader(manager, { runtimeKey: getRuntimeKey(), sdk: {
    getSessionMessages: async (id) => {
      messageReads.push(id)
      onMessages?.()
      return { items: [{ info: { id: `msg_${id}`, sessionID: id, role: "user", time: { created: 1 }, seq: 1 }, parts: [] }], cursor: {} }
    },
  } })
  setImperativeSessionMessageLoader(loader)
  cleanups.push(() => { setImperativeSessionMessageLoader(null); loader.dispose(); manager.disposeAll() })
  const status = spyOn(opencodeClient, "getActiveSessionStatuses").mockResolvedValue({ [own.id]: { type: "busy" }, [other.id]: { type: "busy" } })
  const getSession = spyOn(opencodeClient, "getSession").mockImplementation(async (id) => id === own.id ? own : other)
  const forms = spyOn(opencodeClient, "listPendingForms").mockResolvedValue([])
  const permissions = spyOn(opencodeClient, "listPendingPermissions").mockResolvedValue([])
  cleanups.push(() => { status.mockRestore(); getSession.mockRestore(); forms.mockRestore(); permissions.mockRestore() })
  const routing = createEventRoutingIndex()
  setSyncRefs(opencodeClient.getSdkClient(), manager, directory, (id, owner) => routing.sessionDirectoryById.set(id, owner))
  routing.sessionDirectoryById.set(other.id, other.directory)
  const recover = (isStale = () => false) => resyncDirectoryAfterReconnect(directory, store, routing, "stale-status-resync", isStale)
  return { directory, own, other, store, manager, status, getSession, forms, permissions, messageReads, routing, recover }
}

test("a complete replay refreshes live status and pending requests without rereading records or transcripts", async () => {
  const { directory, own, store, status, getSession, forms, permissions, messageReads, routing } = setup()
  const permission = { id: "per_after_replay", sessionID: own.id, action: "edit", resources: [], metadata: {} }
  permissions.mockResolvedValue([permission])
  expect(await resyncDirectoryAfterReconnect(directory, store, routing, "stream-replayed", () => false)).toBe(true)
  expect(status).toHaveBeenCalledTimes(1)
  expect(forms).toHaveBeenCalledTimes(1)
  expect(permissions).toHaveBeenCalledTimes(1)
  expect(store.getState().session_status[own.id]).toEqual({ type: "busy" })
  expect(store.getState().permission[own.id]).toEqual([permission])
  expect(getSession).not.toHaveBeenCalled()
  expect(messageReads).toEqual([])
})

test("a gap repair after replay still rereads the transcript and reports failed live reads", async () => {
  const { directory, own, store, status, getSession, messageReads, routing } = setup()
  store.setState({ session_status: { [own.id]: { type: "busy" } } })
  status.mockResolvedValue(null)
  expect(await resyncDirectoryAfterReconnect(directory, store, routing, "stream-replayed", () => false)).toBe(false)
  expect(getSession).not.toHaveBeenCalled()
  expect(await resyncDirectoryAfterReconnect(directory, store, routing, "stream-reconnect", () => false)).toBe(false)
  expect(messageReads).toEqual([own.id])
})

test("a global active snapshot recovers only this directory's sessions", async () => {
  const { own, other, store, getSession, messageReads, routing, recover } = setup()
  await recover()
  expect(store.getState().session_status).toEqual({ [own.id]: { type: "busy" } })
  expect(store.getState().session.map((s) => s.id)).toEqual([own.id])
  expect(getSession.mock.calls.map(([id]) => id)).toEqual([own.id])
  expect(messageReads).toEqual([own.id])
  expect(store.getState().message[other.id]).toBeUndefined()
  expect(routing.sessionDirectoryById.get(other.id)).toBe(other.directory)
})

test("a project listing a worktree session does not recover or reindex it as its own", async () => {
  const { own, other, store, messageReads, routing, recover } = setup()
  store.setState({ session: [other, own], session_status: { [other.id]: { type: "busy" } } })
  await recover()
  expect(store.getState().session).toContain(other)
  expect(messageReads).toEqual([own.id])
  expect(routing.sessionDirectoryById.get(other.id)).toBe(other.directory)
  expect(useGlobalSessionStatusStore.getState().statusById.has(other.id)).toBe(false)
})

test("recovery clears a foreign busy status without settling the real owner's activity", async () => {
  const { directory, other, store, status, recover } = setup()
  store.setState({ session: [other], session_status: { [other.id]: { type: "busy" } } })
  applyGlobalSessionStatusSnapshot(other.directory, { [other.id]: { type: "busy" } }, [other.id])
  status.mockResolvedValue({})
  await recover()
  expect(store.getState().session_status).toEqual({})
  expect(directoryUse(directory, store.getState())).toBe("free")
  expect(useGlobalSessionStatusStore.getState().statusById.get(other.id)?.status.type).toBe("busy")
})

test("an unknown candidate's foreign response cannot publish its session or transcript", async () => {
  const { own, other, store, messageReads, routing, recover } = setup()
  const permission = { id: "per_moved", sessionID: other.id, action: "edit", resources: [], metadata: {} }
  applyGlobalBlockingRequestSnapshot(other.directory, { kind: "permissions", groups: { [other.id]: [permission] } }, [other.id])
  store.setState({ session_status: { [other.id]: { type: "busy" } }, message: {
    [other.id]: [{ id: "msg_before_move", sessionID: other.id, role: "user", time: { created: 1 } }],
  } })
  await recover()
  expect(store.getState().session.map((s) => s.id)).toEqual([own.id])
  expect(messageReads).toEqual([own.id])
  expect(store.getState().message[other.id]).toBeUndefined()
  expect(store.getState().session_status[other.id]).toBeUndefined()
  expect(routing.sessionDirectoryById.get(other.id)).toBe(other.directory)
  expect(useGlobalBlockingRequestsStore.getState().bySession.get(other.id)?.permissions.map((request) => request.id)).toEqual([permission.id])
  expect(useGlobalSessionsStore.getState().entityById.get(other.id)?.directory).toBe(other.directory)
})

test("an event-known candidate without a session record still recovers when ownership matches", async () => {
  const { directory, own, other, store, getSession, messageReads, recover } = setup()
  store.setState({ session_status: { [other.id]: { type: "busy" } } })
  getSession.mockImplementation(async (id) => id === own.id ? own : { ...other, directory })
  await recover()
  expect(store.getState().session.map((s) => s.id).sort()).toEqual([own.id, other.id].sort())
  expect(messageReads.sort()).toEqual([own.id, other.id].sort())
})

test("a failed status read preserves existing activity without importing other sessions", async () => {
  const { own, store, status, messageReads, recover } = setup()
  store.setState({ session_status: { [own.id]: { type: "busy" } } })
  status.mockResolvedValue(null)
  expect(await recover()).toBe(false)
  expect(store.getState().session_status[own.id]).toEqual({ type: "busy" })
  expect(messageReads).toEqual([own.id])
})

test("a session read retired by its owner starts no transcript read", async () => {
  const { own, store, getSession, messageReads, recover } = setup()
  let stale = false
  getSession.mockImplementation(async () => { stale = true; return own })
  await recover(() => stale)
  expect(messageReads).toEqual([])
  expect(store.getState().message).toEqual({})
})

test("a move received during the detail read cannot restore the source session", async () => {
  const { own, other, store, manager, directory, getSession, messageReads, routing, recover } = setup()
  let resolve!: (value: Session) => void
  let started!: () => void
  const waiting = new Promise<void>((ready) => { started = ready })
  getSession.mockImplementation(() => { started(); return new Promise((ready) => { resolve = ready }) })
  const recovering = recover()
  await waiting
  handleEvent(directory, { type: "session.patched", properties: { sessionID: own.id,
    patch: { directory: other.directory, time: { updated: 2 } } } }, manager, routing, getRuntimeKey())
  resolve(own)
  await recovering
  expect(store.getState().session).toEqual([])
  expect(messageReads).toEqual([])
  expect(routing.sessionDirectoryById.get(own.id)).toBe(other.directory)
})

test("a move invalidates a status-only candidate before its old detail response arrives", async () => {
  const { own, other, store, manager, directory, getSession, messageReads, routing, recover } = setup()
  store.setState({ session: [], session_status: { [own.id]: { type: "busy" } } })
  let resolve!: (value: Session) => void
  let started!: () => void
  const waiting = new Promise<void>((ready) => { started = ready })
  getSession.mockImplementation(() => { started(); return new Promise((ready) => { resolve = ready }) })
  const recovering = recover()
  await waiting
  handleEvent(directory, { type: "session.patched", properties: { sessionID: own.id,
    patch: { directory: other.directory, time: { updated: 2 } } } }, manager, routing, getRuntimeKey())
  resolve(own)
  await recovering
  expect(store.getState().session).toEqual([])
  expect(store.getState().session_status[own.id]).toBeUndefined()
  expect(messageReads).toEqual([])
  expect(routing.sessionDirectoryById.get(own.id)).toBe(other.directory)
})

test("a move invalidates an unknown candidate's in-flight transcript", async () => {
  const context = setup(() => {
    handleEvent(context.directory, { type: "session.patched", properties: { sessionID: context.own.id,
      patch: { directory: context.other.directory, time: { updated: 2 } } } }, context.manager, context.routing, getRuntimeKey())
  })
  context.store.setState({ session: [], session_status: { [context.own.id]: { type: "busy" } } })
  await context.recover()
  expect(context.store.getState().session).toEqual([])
  expect(context.store.getState().message[context.own.id]).toBeUndefined()
  expect(context.routing.sessionDirectoryById.get(context.own.id)).toBe(context.other.directory)
})

test("a model switch received during the transcript read stays newer than the detail response", async () => {
  const model = { providerID: "openai", id: "gpt-6.1-sol", variant: "high" }
  const context = setup(() => {
    handleEvent(context.directory, { type: "session.patched", properties: { sessionID: context.own.id,
      patch: { model, time: { updated: 2 } } } }, context.manager, context.routing, getRuntimeKey())
  })
  await context.recover()
  expect(context.store.getState().session.find((s) => s.id === context.own.id)?.model).toEqual(model)
})

test("a move during blocking-request recovery preserves the destination's pending request", async () => {
  const { directory, own, other, manager, forms, routing, recover } = setup()
  const permission = { id: "per_during_move", sessionID: own.id, action: "edit", resources: [], metadata: {} }
  applyGlobalBlockingRequestSnapshot(other.directory, { kind: "permissions", groups: { [own.id]: [permission] } }, [own.id])
  forms.mockImplementation(async () => {
    handleEvent(directory, { type: "session.patched", properties: { sessionID: own.id,
      patch: { directory: other.directory, time: { updated: 2 } } } }, manager, routing, getRuntimeKey())
    return []
  })
  expect(await recover()).toBe(false)
  const pending = useGlobalBlockingRequestsStore.getState().bySession.get(own.id)
  expect(pending?.directory).toBe(other.directory)
  expect(pending?.permissions.map((request) => request.id)).toEqual([permission.id])
})
