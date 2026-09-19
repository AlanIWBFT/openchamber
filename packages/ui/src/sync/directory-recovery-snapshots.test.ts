import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { INITIAL_STATE, type State } from "./types"
import {
  readDirectoryPermissionSnapshot as recoverPermissions,
  readDirectoryQuestionSnapshot as recoverQuestions,
  readDirectoryStatusSnapshot,
  recordDirectoryRecoveryEvent,
} from "./directory-recovery-snapshots"
import { ChildStoreManager } from "./child-store"
import { createEventRoutingIndex, handleEvent } from "./sync-context"
import { getRuntimeKey } from "../lib/runtime-switch"
import { replaceGlobalSessionStatusById } from "./global-session-status"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { resolve, promise }
}
const source = (initial: Partial<State> = {}) => createStore<State>(() => ({ ...INITIAL_STATE, ...initial }))
const readDirectoryQuestionSnapshot = (store: ReturnType<typeof source>, read: () => Promise<QuestionRequest[]>, options: Omit<Parameters<typeof recoverQuestions>[2], "commit"> = {}) => (
  recoverQuestions(store, read, { ...options, commit: (question) => store.setState({ question }) })
)
const readDirectoryPermissionSnapshot = (store: ReturnType<typeof source>, read: () => Promise<PermissionRequest[]>, options: Omit<Parameters<typeof recoverPermissions>[2], "commit"> = {}) => (
  recoverPermissions(store, read, { ...options, commit: (permission) => store.setState({ permission }) })
)
const permission: PermissionRequest = { id: "permission", sessionID: "session", permission: "read", patterns: ["*"], metadata: {}, always: [] }
const question: QuestionRequest = { id: "question", sessionID: "session", questions: [] }
const session: Session = {
  id: "session", projectID: "project", slug: "session", directory: "/repo",
  title: "Session", version: "1", time: { created: 1, updated: 1 },
}

describe("directory recovery snapshots", () => {
  test("a newer partial commit does not suppress full recovery of other sessions", async () => {
    const store = source()
    const old = deferred<QuestionRequest[]>()
    const other = { ...question, id: "other", sessionID: "other" }
    const full = readDirectoryQuestionSnapshot(store, () => old.promise)
    await readDirectoryQuestionSnapshot(store, async () => [question], { sessionIDs: ["other"] })
    old.resolve([question, other])
    expect(await full).toEqual({ session: [question] })
    expect(store.getState().question).toEqual({ session: [question] })
  })

  test("disjoint partial recoveries can commit in reverse order", async () => {
    const store = source()
    const old = deferred<QuestionRequest[]>()
    const other = { ...question, id: "other", sessionID: "other" }
    const first = readDirectoryQuestionSnapshot(store, () => old.promise, { sessionIDs: ["session"] })
    await readDirectoryQuestionSnapshot(store, async () => [other], { sessionIDs: ["other"] })
    old.resolve([question])
    expect(await first).toEqual({ session: [question], other: [other] })
  })

  test("a stale newer result grants no authority", async () => {
    const store = source()
    const old = deferred<QuestionRequest[]>()
    const first = readDirectoryQuestionSnapshot(store, () => old.promise)
    await readDirectoryQuestionSnapshot(store, async () => [], { isStale: () => true })
    old.resolve([question])
    expect(await first).toEqual({ session: [question] })
  })

  test("asks and replies during auto-accept survive the final commit", async () => {
    const store = source()
    const started = deferred<void>()
    const accepted = deferred<ReadonlySet<string>>()
    const other = { ...permission, id: "other", sessionID: "other" }
    const replied = { ...permission, id: "replied", sessionID: "replied" }
    const result = readDirectoryPermissionSnapshot(store, async () => [permission, replied], {
      sessionIDs: ["session", "other", "replied"],
      settle: async () => { started.resolve(); return accepted.promise },
    })
    await started.promise
    recordDirectoryRecoveryEvent(store, { id: "ask", type: "permission.asked", properties: other })
    recordDirectoryRecoveryEvent(store, { id: "reply", type: "permission.replied", properties: { sessionID: "replied", requestID: "replied", reply: "once" } })
    // Also cover an ask for an accepted ID observed before its reply event arrives.
    recordDirectoryRecoveryEvent(store, { id: "accepted-ask", type: "permission.asked", properties: permission })
    accepted.resolve(new Set([permission.id]))
    expect(await result).toEqual({ other: [other] })
    expect(store.getState().permission).toEqual({ other: [other] })
  })

  test("a newer empty commit wins while an older auto-accept is pending", async () => {
    const store = source()
    const started = deferred<void>()
    const accepted = deferred<ReadonlySet<string>>()
    const first = readDirectoryPermissionSnapshot(store, async () => [permission], {
      settle: async () => { started.resolve(); return accepted.promise },
    })
    await started.promise
    await readDirectoryPermissionSnapshot(store, async () => [])
    accepted.resolve(new Set())
    expect(await first).toEqual({})
  })

  test("scope invalidation during auto-accept cannot block an earlier valid result", async () => {
    const store = source()
    const old = deferred<PermissionRequest[]>()
    const first = readDirectoryPermissionSnapshot(store, () => old.promise)
    const started = deferred<void>()
    const accepted = deferred<ReadonlySet<string>>()
    let stale = false
    const newer = readDirectoryPermissionSnapshot(store, async () => [], {
      isStale: () => stale,
      settle: async () => { started.resolve(); return accepted.promise },
    })
    await started.promise
    stale = true
    accepted.resolve(new Set())
    await newer
    old.resolve([permission])
    expect(await first).toEqual({ session: [permission] })
  })

  test("an older question response cannot undo a newer successful empty snapshot", async () => {
    const store = source()
    const old = deferred<QuestionRequest[]>()
    const first = readDirectoryQuestionSnapshot(store, () => old.promise)
    store.setState({ question: await readDirectoryQuestionSnapshot(store, async () => []) })
    old.resolve([question])
    expect(await first).toEqual({})
  })

  test("a failed newer permission request leaves an older successful response eligible", async () => {
    const store = source()
    const old = deferred<PermissionRequest[]>()
    const first = readDirectoryPermissionSnapshot(store, () => old.promise)
    await expect(readDirectoryPermissionSnapshot(store, async () => { throw new Error("offline") })).rejects.toThrow("offline")
    old.resolve([permission])
    expect(await first).toEqual({ session: [permission] })
  })

  for (const eventLast of [false, true]) {
    test(`preserves the latest transition when an idle event and optimistic turn overlap (event last: ${eventLast})`, async () => {
      const manager = new ChildStoreManager()
      const store = manager.ensureChild("/repo", { bootstrap: false })
      store.setState({ session: [session], session_status: { session: { type: "busy" } } })
      const response = deferred<State["session_status"]>()
      const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
      const optimistic = () => store.setState({ session_status: { session: { type: "busy" } } })
      try {
        if (eventLast) optimistic()
        handleEvent("/repo", { id: "event-idle", type: "session.idle", properties: { sessionID: "session" } },
          manager, createEventRoutingIndex(), getRuntimeKey(), true)
        if (!eventLast) optimistic()
        response.resolve({})
        expect(await snapshot).toEqual({ session: { type: eventLast ? "idle" : "busy" } })
      } finally {
        response.resolve({})
        manager.disposeAll()
        replaceGlobalSessionStatusById(new Map())
      }
    })
  }

  test("the event pipeline preserves repeated busy events without publishing a redundant store update", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [session], session_status: { session: { type: "busy" } } })
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    let publications = 0
    const unsubscribe = store.subscribe(() => { publications += 1 })
    try {
      handleEvent("/repo", { id: "event-busy", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } },
        manager, createEventRoutingIndex(), getRuntimeKey(), true)
      response.resolve({})
      expect(await snapshot).toEqual({ session: { type: "busy" } })
      expect(publications).toBe(0)
    } finally {
      response.resolve({})
      unsubscribe()
      manager.disposeAll()
      replaceGlobalSessionStatusById(new Map())
    }
  })

  test("a newer idle event cannot be overwritten by an old busy snapshot", async () => {
    const store = source()
    const response = deferred<State["session_status"]>()
    const snapshot = readDirectoryStatusSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-idle", type: "session.idle", properties: { sessionID: "session" } })
    response.resolve({ session: { type: "busy" } })
    expect(await snapshot).toEqual({ session: { type: "idle" } })
  })

  test("an archive event rejected by the reducer cannot erase pending requests from a snapshot", async () => {
    const manager = new ChildStoreManager()
    const store = manager.ensureChild("/repo", { bootstrap: false })
    store.setState({ session: [{ ...session, time: { created: 1, updated: 20 } }] })
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    try {
      handleEvent("/repo", {
        id: "old-archive", type: "session.updated",
        properties: { sessionID: session.id, info: { ...session, time: { created: 1, updated: 10, archived: 10 } } },
      }, manager, createEventRoutingIndex(), getRuntimeKey(), true, undefined, undefined, true)
      response.resolve([permission])
      expect(await snapshot).toEqual({ session: [permission] })
      expect(store.getState().session[0].time.archived).toBeUndefined()
    } finally {
      response.resolve([])
      manager.disposeAll()
    }
  })

  test("equal session IDs in different stores do not share in-flight events", async () => {
    const a = source()
    const b = source()
    const response = deferred<State["session_status"]>()
    const first = readDirectoryStatusSnapshot(a, () => response.promise)
    const second = readDirectoryStatusSnapshot(b, () => response.promise)
    recordDirectoryRecoveryEvent(a, { id: "event-busy", type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    response.resolve({})
    expect(await first).toEqual({ session: { type: "busy" } })
    expect(await second).toEqual({})
  })

  test("a permission reply received before its ask is materialized prevents resurrection", async () => {
    const store = source()
    const response = deferred<PermissionRequest[]>()
    const snapshot = readDirectoryPermissionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-replied", type: "permission.replied", properties: { sessionID: "session", requestID: permission.id, reply: "once" } })
    response.resolve([permission])
    expect(await snapshot).toEqual({})
  })

  test("a question reply prevents an old HTTP response from reopening it", async () => {
    const store = source()
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-replied", type: "question.replied", properties: { sessionID: "session", requestID: question.id, answers: [] } })
    response.resolve([question])
    expect(await snapshot).toEqual({})
  })

  test("new asks survive empty snapshots and supersede older copies of the same request", async () => {
    const store = source()
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    const newer: QuestionRequest = { ...question, questions: [{ question: "Proceed?", header: "Confirm", options: [] }] }
    recordDirectoryRecoveryEvent(store, { id: "event-asked", type: "question.asked", properties: newer })
    response.resolve([question])
    expect(await snapshot).toEqual({ session: [newer] })
    const permissionSnapshot = readDirectoryPermissionSnapshot(store, async () => [])
    recordDirectoryRecoveryEvent(store, { id: "event-asked", type: "permission.asked", properties: permission })
    expect(await permissionSnapshot).toEqual({ session: [permission] })
  })

  test("direct local mutations survive while unchanged stale requests are removed", async () => {
    const store = source({ question: { session: [question] } })
    const response = deferred<QuestionRequest[]>()
    const snapshot = readDirectoryQuestionSnapshot(store, () => response.promise)
    const added = { ...question, id: "new-question" }
    store.setState({ question: { session: [question, added] } })
    response.resolve([])
    expect(await snapshot).toEqual({ session: [added] })
  })

  test("deleting a session invalidates its status and blocking requests in every in-flight snapshot", async () => {
    const store = source()
    const statusResponse = deferred<State["session_status"]>()
    const permissionResponse = deferred<PermissionRequest[]>()
    const questionResponse = deferred<QuestionRequest[]>()
    const statuses = readDirectoryStatusSnapshot(store, () => statusResponse.promise)
    const permissions = readDirectoryPermissionSnapshot(store, () => permissionResponse.promise)
    const questions = readDirectoryQuestionSnapshot(store, () => questionResponse.promise)
    recordDirectoryRecoveryEvent(store, { id: "event-deleted", type: "session.deleted", properties: { sessionID: session.id, info: session } })
    statusResponse.resolve({ session: { type: "busy" } })
    permissionResponse.resolve([permission])
    questionResponse.resolve([question])
    expect(await statuses).toEqual({})
    expect(await permissions).toEqual({})
    expect(await questions).toEqual({})
  })

  test("failed reads leave no event history for a later successful snapshot", async () => {
    const store = source()
    for (let index = 0; index < 100; index += 1) {
      await expect(readDirectoryStatusSnapshot(store, async () => { throw new Error("offline") })).rejects.toThrow("offline")
      recordDirectoryRecoveryEvent(store, { id: `event-${index}`, type: "session.status", properties: { sessionID: "session", status: { type: "busy" } } })
    }
    expect(await readDirectoryStatusSnapshot(store, async () => ({}))).toEqual({})
  })
})
