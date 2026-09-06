import { describe, expect, test } from "bun:test"
import type { MessagePage } from "@/lib/opencode/client"
import type { TextPart } from "@/lib/opencode/model"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader, type SessionMessagePageSource } from "./session-message-loader"
import {
  createFirstVisibleSessionPerformanceTracker,
  startSessionLoadPerformanceEvent,
} from "./session-load-performance"

const createRecord = (sessionID: string, id = "msg_1", seq = Number(id.match(/\d+$/)?.[0] ?? 1), created = 1): MessagePage["items"][number] => ({
  info: { id, sessionID, role: "user", time: { created }, seq },
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello" }],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => {
    resolve = next
    reject = fail
  })
  return { promise, resolve, reject }
}

const response = (items: ReturnType<typeof createRecord>[], cursor?: string): MessagePage => ({
  items,
  cursor: cursor ? { next: cursor } : {},
})

/** The adapter rejects; the loader only ever sees a thrown error with a status. */
const failure = (status: number, message: string): never => {
  throw Object.assign(new Error(`session.messages failed (${status}): ${message}`), { status })
}

type PageRequest = { sessionID: string; directory?: string; limit?: number; cursor?: string }

const createLoader = (getPage: (input: PageRequest) => Promise<MessagePage>) => {
  const childStores = new ChildStoreManager()
  const sdk = {
    getSessionMessages: (
      sessionID: string,
      options?: { limit?: number; cursor?: string },
      directory?: string | null,
    ) => getPage({ sessionID, directory: directory ?? undefined, limit: options?.limit, cursor: options?.cursor }),
  }
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
  return { childStores, loader }
}

describe("SessionMessageLoader", () => {
  test("confirmed optimism is not resurrected when a later complete history omits it", async () => {
    const target = { directory: "/confirmed-input", sessionID: "session" }
    const older = createRecord(target.sessionID, "older", 1)
    const confirmed = createRecord(target.sessionID, "confirmed", 2)
    const { childStores, loader } = createLoader(async () => response([older]))
    try {
      loader.initializeCreatedSession(target)
      loader.optimisticAdd({ ...target, message: { ...confirmed.info, seq: undefined }, parts: confirmed.parts })
      const store = childStores.getChild(target.directory)!
      store.setState({ message: { [target.sessionID]: [confirmed.info] } })
      await loader.refreshComplete(target)
      expect(store.getState().message[target.sessionID]).toEqual([older.info])
      expect(store.getState().part[confirmed.info.id]).toBeUndefined()
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })
  test("opens a confirmed new session without fetching history", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return failure(404, "not found")
    })
    const target = { directory: "/created-repo", sessionID: "session-created" }

    loader.initializeCreatedSession(target)
    await loader.ensure(target, { reason: "navigation" })
    await loader.ensure(target, { reason: "reactive" })

    expect(calls).toBe(0)
    expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", resolved: true, complete: true })
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])

    const record = createRecord(target.sessionID)
    loader.optimisticAdd({ ...target, message: record.info, parts: record.parts })
    await loader.ensure(target)
    expect(calls).toBe(0)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])

    // Explicit recovery still reaches the server and exposes a real failure.
    await loader.ensure(target, { force: true })
    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])
    loader.dispose()
    childStores.disposeAll()
  })

  test("creation supersedes an early history failure without losing the first prompt", async () => {
    const pending = deferred<MessagePage>()
    const { childStores, loader } = createLoader(() => pending.promise)
    const target = { directory: "/created-race", sessionID: "session-created" }
    const earlyLoad = loader.ensure(target)

    loader.initializeCreatedSession(target)
    const record = createRecord(target.sessionID)
    loader.optimisticAdd({ ...target, message: record.info, parts: record.parts })
    pending.reject(Object.assign(new Error("session.messages failed (404): not found"), { status: 404 }))
    await earlyLoad

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([record.info])
    expect(childStores.getChild(target.directory)?.getState().part[record.info.id]).toEqual(record.parts)
    loader.dispose()
    childStores.disposeAll()
  })

  test("creation preserves messages and history coverage received before its response", async () => {
    const record = createRecord("session-created")
    const { childStores, loader } = createLoader(async () => response([record], "older-cursor"))
    const target = { directory: "/created-events", sessionID: "session-created" }
    await loader.ensure(target)
    const before = childStores.getChild(target.directory)?.getState()
    const coverage = loader.getSnapshot(target)

    loader.initializeCreatedSession(target)

    expect(childStores.getChild(target.directory)?.getState()).toBe(before)
    expect(loader.getSnapshot(target)).toBe(coverage)
    loader.dispose()
    childStores.disposeAll()
  })

  test("deduplicates navigation and reactive loading for the same target", async () => {
    const pending = deferred<MessagePage>()
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      return pending.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const navigation = loader.ensure(target, { reason: "navigation" })
    const reactive = loader.ensure(target, { reason: "reactive" })
    expect(calls).toBe(1)

    pending.resolve(response([createRecord(target.sessionID)]))
    await Promise.all([navigation, reactive])

    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not fetch when a required message is already materialized", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ limit, cursor }) => {
      calls.push({ limit, cursor })
      return response([])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "target").info] },
    })

    const loaded = await loader.loadUntil(target, { kind: "message", messageID: "target" })
    expect(loaded).toBe(true)
    expect(calls).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("resolves a missing requirement after cached messages established no coverage metadata", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      return response([createRecord(sessionID, "target")])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached").info] },
    })

    await loader.ensure(target)
    const loaded = await loader.loadUntil(target, { kind: "message", messageID: "target" })

    expect(loaded).toBe(true)
    expect(calls).toEqual([{ limit: 100, cursor: undefined }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("pages only until a missing required message is found", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      return cursor
        ? response([createRecord(sessionID, "target", 1)])
        : response([createRecord(sessionID, "latest", 2)], "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loaded = await loader.loadUntil(target, { kind: "message", messageID: "target" })
    expect(loaded).toBe(true)
    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "older-cursor" },
    ])
    expect(calls.every((call) => call.limit !== 0)).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("deduplicates concurrent boundary seeks", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      return cursor
        ? response([createRecord(sessionID, "target", 1)])
        : response([createRecord(sessionID, "latest", 2)], "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loaded = await Promise.all([
      loader.loadUntil(target, { kind: "message", messageID: "target" }),
      loader.loadUntil(target, { kind: "message", messageID: "target" }),
    ])
    expect(loaded).toEqual([true, true])
    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "older-cursor" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("loads the whole synthetic context prefix and stops before unrelated older history", async () => {
    const calls: Array<string | undefined> = []
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push(cursor)
      if (!cursor) return response([createRecord(sessionID, "target", 4)], "context")
      if (cursor === "context") return response([{
        info: { id: "context", sessionID, role: "synthetic", seq: 3, time: { created: 1 }, text: "attached context" },
        parts: [],
      }], "previous")
      if (cursor === "previous") return response([createRecord(sessionID, "previous", 2)], "unneeded")
      throw new Error("Read past the required context")
    })
    const target = { directory: "/context", sessionID: "context-session" }
    try {
      expect(await loader.loadUntil(target, { kind: "message", messageID: "target" })).toBe(true)
      expect(calls).toEqual([undefined])
      expect(await loader.loadUntil(target, { kind: "message-context", messageID: "target" })).toBe(true)
      expect(calls).toEqual([undefined, "context", "previous"])
      expect(loader.getSnapshot(target).complete).toBe(false)
      expect(childStores.getChild(target.directory)?.getState().message[target.sessionID].map((message) => message.id))
        .toEqual(["previous", "context", "target"])
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("does not accept a truncated context prefix after a page read fails", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      if (cursor) return failure(400, "context rejected")
      return response([createRecord(sessionID, "target", 2)], "context")
    })
    const target = { directory: "/context-error", sessionID: "context-error" }
    try {
      await expect(loader.loadUntil(target, { kind: "message-context", messageID: "target" }))
        .rejects.toThrow("context rejected")
      expect(childStores.getChild(target.directory)?.getState().message[target.sessionID].map((message) => message.id)).toEqual(["target"])
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("accepts a complete context prefix at the beginning of history", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return response([createRecord(sessionID, "target", 1)])
    })
    const target = { directory: "/first-message", sessionID: "first-message" }
    try {
      expect(await loader.loadUntil(target, { kind: "message-context", messageID: "target" })).toBe(true)
      expect(await loader.loadUntil(target, { kind: "message-context", messageID: "target" })).toBe(true)
      expect(calls).toBe(1)
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("stops a cancelled seek after its current page completes", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      if (!cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const controller = new AbortController()
    const lookup = loader.loadUntil(
      target,
      { kind: "message", messageID: "target" },
      { signal: controller.signal },
    )

    await olderRequestStarted.promise
    controller.abort()
    olderPage.resolve(response([createRecord(target.sessionID, "older", 1)], "cursor-b"))

    expect(await lookup).toBe(false)
    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "cursor-a" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not cancel a shared page needed by an active seek", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      if (!cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const controller = new AbortController()
    const cancelledLookup = loader.loadUntil(
      target,
      { kind: "message", messageID: "target" },
      { signal: controller.signal },
    )

    await olderRequestStarted.promise
    const activeLookup = loader.loadUntil(target, { kind: "message", messageID: "target" })
    controller.abort()
    olderPage.resolve(response([createRecord(target.sessionID, "target", 1)]))

    expect(await cancelledLookup).toBe(false)
    expect(await activeLookup).toBe(true)
    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "cursor-a" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("leaves older history loading to explicit viewport demand", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      // Ten prompts satisfy the cold-navigation turn target without expansion.
      return cursor
        ? response([createRecord(sessionID, "msg_older", 1)])
        : response(Array.from({ length: 10 }, (_, index) => createRecord(sessionID, `msg_${index + 2}`, index + 2)), "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { reason: "prefetch" })
    await Promise.resolve()

    expect(calls).toEqual([{ limit: 100, cursor: undefined }])
    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")

    await loader.loadOlder(target)

    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 100, cursor: "older-cursor" },
    ])
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_older", ...Array.from({ length: 10 }, (_, index) => `msg_${index + 2}`)])
    loader.dispose()
    childStores.disposeAll()
  })

  test("keeps a post-rollover tail ordered by sequence for every shared runtime", async () => {
    for (const runtimeKey of ["web", "desktop", "vscode", "mobile"]) {
      const childStores = new ChildStoreManager()
      const sdk = {
        getSessionMessages: async (sessionID: string) => response([
          createRecord(sessionID, "msg_000000000000Current", 200, 100),
          createRecord(sessionID, "msg_ffffffffffffLegacy", 100, 200),
        ]),
      }
      const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey })
      const target = { directory: `/repo-${runtimeKey}`, sessionID: "session-a" }

      await loader.ensure(target)

      expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
        .toEqual(["msg_ffffffffffffLegacy", "msg_000000000000Current"])
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("loads every history page for an explicit complete-history request", async () => {
    const calls: Array<{ cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (!cursor) return response([createRecord(sessionID, "msg_latest", 3)], "cursor-2")
      if (cursor === "cursor-2") return response([createRecord(sessionID, "msg_middle", 2)], "cursor-1")
      return response([createRecord(sessionID, "msg_oldest", 1)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadComplete(target)

    expect(calls).toEqual([
      { cursor: undefined },
      { cursor: "cursor-2" },
      { cursor: "cursor-1" },
    ])
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("keeps streaming changes while the initial window waits for an older page", async () => {
    const older = deferred<MessagePage>()
    const olderRequested = deferred<void>()
    const target = { directory: "/window-race", sessionID: "session-window" }
    const latest = createRecord(target.sessionID, "msg_latest", 9)
    latest.info = { ...latest.info, role: "assistant", agent: "build", providerID: "test", modelID: "test" }
    const { childStores, loader } = createLoader(async ({ cursor }) => {
      if (!cursor) return response([latest], "older")
      olderRequested.resolve()
      return older.promise
    })
    const loading = loader.ensure(target)
    try {
      await olderRequested.promise
      const store = childStores.getChild(target.directory)!
      const provisional = { ...latest.info, seq: undefined }
      const live: TextPart = { id: latest.parts[0].id, sessionID: target.sessionID, messageID: latest.info.id, type: "text", text: "new live output" }
      recordDirectoryRecoveryEvent(store, { type: "message.updated", properties: { info: provisional } })
      recordDirectoryRecoveryEvent(store, { type: "message.part.updated", properties: { sessionID: target.sessionID, part: live } })
      store.setState({ message: { [target.sessionID]: [provisional] }, part: { [latest.info.id]: [live] } })
      older.resolve(response([createRecord(target.sessionID, "msg_older", 1)]))
      await loading
      expect(store.getState().message[target.sessionID].map((message) => message.seq)).toEqual([1, 9])
      expect(store.getState().part[latest.info.id][0]).toBe(live)
    } finally {
      older.resolve(response([]))
      await loading
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("complete refresh pages atomically and removes stale history only after every page succeeds", async () => {
    let failOlder = true
    const calls: PageRequest[] = []
    const { childStores, loader } = createLoader(async (input) => {
      calls.push(input)
      if (!input.cursor) return response([createRecord(input.sessionID, "latest", 9)], "older")
      if (failOlder) return failure(400, "older rejected")
      return response([createRecord(input.sessionID, "oldest", 1)])
    })
    const target = { directory: "/complete-refresh", sessionID: "session-complete" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    const stale = createRecord(target.sessionID, "stale", 3)
    store.setState({ message: { [target.sessionID]: [stale.info] }, part: { [stale.info.id]: stale.parts } })
    const before = store.getState().message
    try {
      await loader.refreshComplete(target)
      expect(loader.getSnapshot(target).status).toBe("error")
      expect(store.getState().message).toBe(before)
      failOlder = false
      await loader.refreshComplete(target)
      expect(loader.getSnapshot(target)).toMatchObject({ status: "ready", complete: true })
      expect(store.getState().message[target.sessionID].map((message) => message.id)).toEqual(["oldest", "latest"])
      expect(store.getState().part.stale).toBeUndefined()
      expect(calls.map((call) => call.cursor)).toEqual([undefined, "older", undefined, "older"])
      expect(calls.every((call) => call.limit === 100)).toBe(true)
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("rejects a complete-history request when its initial load fails", async () => {
    const { childStores, loader } = createLoader(async () => failure(400, "rejected"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): rejected")

    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when an older page fails", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => cursor
      ? failure(400, "older rejected")
      : response([createRecord(sessionID)], "older-cursor"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): older rejected")

    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a failed older cursor on the next bounded lookup", async () => {
    let olderAttempts = 0
    const calls: Array<{ cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (!cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderAttempts += 1
      if (olderAttempts === 1) {
        return failure(400, "older rejected")
      }
      return response([createRecord(sessionID, "target", 1)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadUntil(target, { kind: "message", messageID: "target" }))
      .rejects.toThrow("session.messages failed (400): older rejected")
    expect(loader.getSnapshot(target).status).toBe("error")
    expect(loader.getSnapshot(target).cursor).toBe("cursor-a")

    expect(await loader.loadUntil(target, { kind: "message", messageID: "target" })).toBe(true)
    expect(calls).toEqual([
      { cursor: undefined },
      { cursor: "cursor-a" },
      { cursor: "cursor-a" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("fetches authoritative coverage when renderable messages have no loader metadata", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached").info] },
    })

    await loader.loadComplete(target)

    expect(calls).toBe(1)
    expect(loader.getSnapshot(target).complete).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects repeated pagination cursors instead of looping forever", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls += 1
      if (!cursor) return response([createRecord(sessionID, "latest", 3)], "cursor-a")
      if (cursor === "cursor-a") return response([createRecord(sessionID, "middle", 2)], "cursor-b")
      return response([createRecord(sessionID, "older", 1)], "cursor-a")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("Session history pagination made no progress")

    expect(calls).toBe(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a requested tail refresh after an older in-flight load", async () => {
    const initial = deferred<MessagePage>()
    const refresh = deferred<MessagePage>()
    let calls = 0
    const limits: number[] = []
    const { childStores, loader } = createLoader(async ({ limit }) => {
      calls += 1
      limits.push(limit ?? 0)
      return calls === 1 ? initial.promise : refresh.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target, { reason: "navigation" })
    const refreshing = loader.refreshTail(target, 30)
    const duplicateRefresh = loader.refreshTail(target, 80)
    expect(calls).toBe(1)
    expect(duplicateRefresh).toBe(refreshing)

    initial.resolve(response([createRecord(target.sessionID, "msg_1")]))
    await loading
    await Promise.resolve()
    expect(calls).toBe(2)
    expect(limits).toEqual([100, 80])

    refresh.resolve(response([createRecord(target.sessionID, "msg_2")]))
    await Promise.all([refreshing, duplicateRefresh])

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_1", "msg_2"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("preserves complete history coverage across a tail refresh", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1
        ? response([createRecord(sessionID, "msg_1")])
        : response([createRecord(sessionID, "msg_2")], "stale-tail-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)

    await loader.refreshTail(target, 2)

    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not deduplicate identical session IDs across directories", async () => {
    const calls: string[] = []
    const { childStores, loader } = createLoader(async ({ directory, sessionID }) => {
      calls.push(directory ?? "")
      return response([createRecord(sessionID)])
    })

    await Promise.all([
      loader.ensure({ directory: "/repo-a", sessionID: "shared" }),
      loader.ensure({ directory: "/repo-b", sessionID: "shared" }),
    ])

    expect(calls.sort()).toEqual(["/repo-a", "/repo-b"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("loads older history with the selected directory's cursor for duplicate session IDs", async () => {
    const providerDirectory = "/repo/provider"
    const selectedDirectory = "/repo/selected-worktree"
    const sessionID = "shared"
    const calls: Array<{ directory?: string; cursor?: string }> = []
    const { childStores, loader } = createLoader(async ({ directory, cursor }) => {
      calls.push({ directory, cursor })
      return cursor
        ? response([createRecord(sessionID, `older-${directory}`, 1)])
        : response([createRecord(sessionID, `latest-${directory}`, 2)], `${directory}-cursor`)
    })

    await Promise.all([
      loader.ensure({ directory: providerDirectory, sessionID }),
      loader.ensure({ directory: selectedDirectory, sessionID }),
    ])

    // Cold navigation extends each directory's window through its own cursor.
    expect(calls.filter((call) => call.cursor)).toEqual([
      { directory: providerDirectory, cursor: `${providerDirectory}-cursor` },
      { directory: selectedDirectory, cursor: `${selectedDirectory}-cursor` },
    ])
    expect(loader.getSnapshot({ directory: selectedDirectory, sessionID }).complete).toBe(true)
    calls.length = 0
    await loader.loadOlder({ directory: selectedDirectory, sessionID })
    expect(calls).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("exposes a retryable error without clearing an existing snapshot", async () => {
    let fail = true
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      if (fail) return failure(400, "rejected")
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: [{ id: "cached", sessionID: target.sessionID, seq: 0, role: "user", time: { created: 0 } }] } })

    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("error")
    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(400)
    expect(store.getState().message[target.sessionID]?.[0]?.id).toBe("cached")

    fail = false
    await loader.ensure(target, { force: true })
    expect(loader.getSnapshot(target).status).toBe("ready")
    loader.dispose()
    childStores.disposeAll()
  })

  test("propagates a zero response status on SDK errors", async () => {
    const { childStores, loader } = createLoader(async () => failure(0, "network rejected"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { force: true })

    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(0)
    loader.dispose()
    childStores.disposeAll()
  })

  test("can invalidate loads for a directory move without discarding cached sequences", async () => {
    const { beginMessageSnapshot } = await import("./message-snapshot")
    const { childStores, loader } = createLoader(async ({ sessionID }) => response([createRecord(sessionID, "cached", 5)]))
    const target = { directory: "/repo", sessionID: "session-a" }
    try {
      await loader.ensure(target)
      const store = childStores.getChild(target.directory)!
      const snapshot = beginMessageSnapshot(store, target.sessionID)
      const parts = store.getState().part

      loader.invalidateSession(target)

      expect(loader.getSnapshot(target).status).toBe("idle")
      expect(store.getState().message[target.sessionID]?.[0]?.id).toBe("cached")
      expect(store.getState().message[target.sessionID]?.[0]?.seq).toBe(5)
      expect(store.getState().part).toBe(parts)
      expect(snapshot.isCurrent()).toBe(false)
      snapshot.dispose()
    } finally {
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("prevents an evicted in-flight request from repopulating the store", async () => {
    const pending = deferred<MessagePage>()
    const { childStores, loader } = createLoader(async () => pending.promise)
    const target = { directory: "/repo", sessionID: "session-a" }

    const loading = loader.ensure(target)
    loader.invalidateSession(target)
    pending.resolve(response([createRecord(target.sessionID)]))
    await loading

    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toBe(undefined)
    expect(loader.getSnapshot(target).status).toBe("idle")
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not start another page after directory invalidation while loading older history", async () => {
    const calls: Array<{ cursor?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (!cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadUntil(target, { kind: "latest-user" })
    const loading = loader.loadOlder(target)
    await olderRequestStarted.promise

    loader.invalidateDirectory(target.directory)
    olderPage.resolve(response([createRecord(target.sessionID, "older", 1)], "cursor-b"))
    await loading

    expect(calls).toEqual([{ cursor: undefined }, { cursor: "cursor-a" }])
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not continue an older-page lookup after the session is invalidated", async () => {
    const calls: Array<{ cursor?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (!cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadUntil(target, { kind: "latest-user" })
    const loading = loader.loadOlder(target)
    await olderRequestStarted.promise

    loader.invalidateSession(target)
    olderPage.resolve(response([createRecord(target.sessionID, "older", 1)], "cursor-b"))
    await loading

    expect(calls).toEqual([{ cursor: undefined }, { cursor: "cursor-a" }])
    expect(loader.getSnapshot(target).status).toBe("idle")
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not start an older page after directory invalidation while waiting for a tail refresh", async () => {
    const calls: Array<{ limit?: number; cursor?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, limit, cursor }) => {
      calls.push({ limit, cursor })
      if (cursor) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })

    await loader.loadUntil(target, { kind: "latest-user" })
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    loader.invalidateDirectory(target.directory)
    store.setState({ message: {}, part: {} })
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([
      { limit: 100, cursor: undefined },
      { limit: 20, cursor: undefined },
    ])
    expect(store.getState().message[target.sessionID]).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not recreate a disposed directory after waiting for a tail refresh", async () => {
    const calls: Array<{ cursor?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (cursor) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadUntil(target, { kind: "latest-user" })
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    expect(childStores.disposeDirectory(target.directory)).toBe(true)
    loader.invalidateDirectory(target.directory)
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([{ cursor: undefined }, { cursor: undefined }])
    expect(childStores.getChild(target.directory)).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not start another page after loader disposal while waiting for a tail refresh", async () => {
    const calls: Array<{ cursor?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, cursor }) => {
      calls.push({ cursor })
      if (cursor) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadUntil(target, { kind: "latest-user" })
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    loader.dispose()
    childStores.disposeAll()
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([{ cursor: undefined }, { cursor: undefined }])
    expect(childStores.getChild(target.directory)).toBe(undefined)
  })

  test("retries initial coverage after an SDK transport switch for the same runtime", async () => {
    const oldInitial = deferred<ReturnType<typeof response>>()
    const oldCalls: Array<{ cursor?: string }> = []
    const newCalls: Array<{ cursor?: string }> = []
    const childStores = new ChildStoreManager()
    const oldSdk: SessionMessagePageSource = {
      getSessionMessages: async (_sessionID, options) => {
        oldCalls.push({ cursor: options?.cursor })
        return oldInitial.promise
      },
    }
    const newSdk: SessionMessagePageSource = {
      getSessionMessages: async (sessionID, options) => {
        newCalls.push({ cursor: options?.cursor })
        return options?.cursor
          ? response([createRecord(sessionID, "target", 1)])
          : response([createRecord(sessionID, "latest", 2)], "cursor-a")
      },
    }
    const loader = new SessionMessageLoader(childStores, { sdk: oldSdk, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached", 0).info] },
      part: { cached: createRecord(target.sessionID, "cached", 0).parts },
    })
    await loader.ensure(target)
    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    const lookup = loader.loadUntil(target, { kind: "message", messageID: "target" })

    loader.configure({ sdk: newSdk, runtimeKey: "runtime-a" })
    oldInitial.resolve(response([createRecord(target.sessionID, "stale", 1)], "stale-cursor"))

    expect(await lookup).toBe(true)
    expect(oldCalls).toEqual([{ cursor: undefined }])
    expect(newCalls).toEqual([{ cursor: undefined }, { cursor: "cursor-a" }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries an older cursor after an SDK transport switch for the same runtime", async () => {
    const oldOlderStarted = deferred<void>()
    const oldOlder = deferred<ReturnType<typeof response>>()
    const oldCalls: Array<{ cursor?: string }> = []
    const newCalls: Array<{ cursor?: string }> = []
    const childStores = new ChildStoreManager()
    const oldSdk: SessionMessagePageSource = {
      getSessionMessages: async (sessionID, options) => {
        oldCalls.push({ cursor: options?.cursor })
        if (!options?.cursor) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
        oldOlderStarted.resolve()
        return oldOlder.promise
      },
    }
    const newSdk: SessionMessagePageSource = {
      getSessionMessages: async (sessionID, options) => {
        newCalls.push({ cursor: options?.cursor })
        return response([createRecord(sessionID, "target", 1)])
      },
    }
    const loader = new SessionMessageLoader(childStores, { sdk: oldSdk, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-a" }
    const lookup = loader.loadUntil(target, { kind: "message", messageID: "target" })

    await oldOlderStarted.promise
    loader.configure({ sdk: newSdk, runtimeKey: "runtime-a" })
    oldOlder.resolve(response([createRecord(target.sessionID, "stale-target", 1)]))

    expect(await lookup).toBe(true)
    expect(oldCalls).toEqual([{ cursor: undefined }, { cursor: "cursor-a" }])
    expect(newCalls).toEqual([{ cursor: "cursor-a" }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("treats an empty successful response as resolved authoritative state", async () => {
    const { childStores, loader } = createLoader(async () => response([]))
    const target = { directory: "/repo", sessionID: "empty" }

    await loader.ensure(target)

    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toEqual([])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a transient page failure instead of treating it as an empty snapshot", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1 ? failure(503, "unavailable") : response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)

    expect(calls).toBe(2)
    expect(loader.getSnapshot(target).status).toBe("ready")
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.length).toBe(1)
    loader.dispose()
    childStores.disposeAll()
  })

  test("reports retries and every downloaded initial expansion record", async () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      location: { search: "" },
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    const target = { directory: "/repo", sessionID: "session-a" }
    let calls = 0
    const { childStores, loader } = createLoader(async () => {
      calls += 1
      if (calls === 1) return failure(503, "unavailable")
      if (calls === 2) {
        const assistant = createRecord(target.sessionID, "msg_assistant")
        assistant.info = { ...assistant.info, role: "assistant", agent: "build", providerID: "test", modelID: "test" }
        return response([assistant], "older")
      }
      return response([createRecord(target.sessionID, "msg_user")])
    })

    try {
      await loader.ensure(target)

      const events = diagnosticWindow.__openchamberSessionLoadPerformance?.events ?? []
      const initialEvent = events.find((event) => event.operation === "session-messages.initial")
      const pageEvents = events.filter((event) => event.operation === "session-messages.page")
      expect(calls).toBe(3)
      expect(pageEvents.map((event) => event.requestLimit)).toEqual([100, 100])
      expect(pageEvents.map((event) => event.cursorPresent)).toEqual([false, true])
      expect(pageEvents.map((event) => event.recordCount)).toEqual([1, 1])
      expect(initialEvent?.outcome).toBe("complete")
      expect(initialEvent?.retryCount).toBe(1)
      expect(initialEvent?.recordCount).toBe(2)
      expect("runtimeKey" in initialEvent!).toBe(false)
      expect("directory" in initialEvent!).toBe(false)
      expect("sessionID" in initialEvent!).toBe(false)
    } finally {
      loader.dispose()
      childStores.disposeAll()
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })
})

describe("session load performance diagnostics", () => {
  test("rejects unknown raw labels and preserves approved input counts", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    const diagnosticWindow = {
      localStorage: {
        getItem: (key: string) => key === "openchamber_session_load_perf" ? "1" : null,
      },
    } as unknown as Window
    Object.defineProperty(globalThis, "window", { configurable: true, value: diagnosticWindow })

    try {
      const finishUnknown = startSessionLoadPerformanceEvent({
        operation: "secret-operation",
        caller: "secret-caller",
        recordCount: 999,
      })
      finishUnknown("complete")
      const finishVisible = startSessionLoadPerformanceEvent({
        operation: "session-messages.visible",
        caller: "selected-session",
        recordCount: 30,
      })
      finishVisible("complete")

      expect(diagnosticWindow.__openchamberSessionLoadPerformance?.events).toHaveLength(1)
      const event = diagnosticWindow.__openchamberSessionLoadPerformance?.events[0]
      expect(event?.operation).toBe("session-messages.visible")
      expect(event?.caller).toBe("selected-session")
      expect(event?.recordCount).toBe(30)
      expect(JSON.stringify(diagnosticWindow.__openchamberSessionLoadPerformance)).not.toContain("secret")
    } finally {
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  test("does not schedule visibility work while diagnostics are disabled", () => {
    let requestedFrames = 0
    let visibleMarks = 0
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => false,
      requestFrame: () => {
        requestedFrames += 1
        return 1
      },
      cancelFrame: () => undefined,
      markVisible: () => {
        visibleMarks += 1
      },
    })

    tracker.schedule("session-a", 10)

    expect(requestedFrames).toBe(0)
    expect(visibleMarks).toBe(0)
  })

  test("reschedules an identity when its pending visibility frame was canceled", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    const cancelFirstA = tracker.schedule("session-a", 10)
    cancelFirstA()
    const cancelB = tracker.schedule("session-b", 10)
    cancelB()
    tracker.schedule("session-a", 10)
    frames.get(3)?.(0)

    expect(marks).toEqual(["visible"])
  })

  test("does not remeasure a completed identity after another session", () => {
    let nextFrame = 0
    const frames = new Map<number, FrameRequestCallback>()
    const marks: string[] = []
    const tracker = createFirstVisibleSessionPerformanceTracker({
      enabled: () => true,
      requestFrame: (callback) => {
        nextFrame += 1
        frames.set(nextFrame, callback)
        return nextFrame
      },
      cancelFrame: (frame) => {
        frames.delete(frame)
      },
      markVisible: () => marks.push("visible"),
      startEvent: () => () => undefined,
    })

    tracker.schedule("session-a", 10)
    frames.get(1)?.(0)
    tracker.schedule("session-b", 10)
    frames.get(2)?.(0)
    tracker.schedule("session-a", 10)

    expect(nextFrame).toBe(2)
    expect(marks).toEqual(["visible", "visible"])
  })
})
