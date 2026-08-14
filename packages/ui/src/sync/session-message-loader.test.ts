import { describe, expect, test } from "bun:test"
import type { Message, OpencodeClient, Part } from "@opencode-ai/sdk/v2/client"
import { ChildStoreManager } from "./child-store"
import { SessionMessageLoader } from "./session-message-loader"
import {
  createFirstVisibleSessionPerformanceTracker,
  startSessionLoadPerformanceEvent,
} from "./session-load-performance"

const createRecord = (sessionID: string, id = "msg_1", sequence = Number(id.match(/\d+$/)?.[0] ?? 1)) => ({
  info: { id, sessionID, role: "user", time: { created: 1 }, seq: sequence } as unknown as Message,
  parts: [{ id: `part_${id}`, messageID: id, sessionID, type: "text", text: "hello", seq: sequence }] as unknown as Part[],
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

const response = (data: ReturnType<typeof createRecord>[], cursor?: string) => ({
  data,
  response: { headers: { get: (name: string) => name === "x-next-cursor" ? cursor ?? null : null } },
})

const createLoader = (messages: (input: {
  sessionID: string
  directory?: string
  limit?: number
  before?: string
}) => Promise<unknown>) => {
  const childStores = new ChildStoreManager()
  const sdk = { session: { messages } } as unknown as OpencodeClient
  const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey: "runtime-a" })
  return { childStores, loader }
}

describe("SessionMessageLoader", () => {
  test("deduplicates navigation and reactive loading for the same target", async () => {
    const pending = deferred<ReturnType<typeof response>>()
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
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ limit, before }) => {
      calls.push({ limit, before })
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
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      return response([createRecord(sessionID, "target")])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached").info] },
    })

    await loader.ensure(target)
    const loaded = await loader.loadUntil(target, { kind: "message", messageID: "target" })

    expect(loaded).toBe(true)
    expect(calls).toEqual([{ limit: 50, before: undefined }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("pages only until a missing required message is found", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      return before
        ? response([createRecord(sessionID, "target", 1)])
        : response([createRecord(sessionID, "latest", 2)], "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    const loaded = await loader.loadUntil(target, { kind: "message", messageID: "target" })
    expect(loaded).toBe(true)
    expect(calls).toEqual([
      { limit: 50, before: undefined },
      { limit: 100, before: "older-cursor" },
    ])
    expect(calls.every((call) => call.limit !== 0)).toBe(true)
    loader.dispose()
    childStores.disposeAll()
  })

  test("deduplicates concurrent boundary seeks", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      return before
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
      { limit: 50, before: undefined },
      { limit: 100, before: "older-cursor" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("stops a cancelled seek after its current page completes", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
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
      { limit: 50, before: undefined },
      { limit: 100, before: "cursor-a" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not cancel a shared page needed by an active seek", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
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
      { limit: 50, before: undefined },
      { limit: 100, before: "cursor-a" },
    ])
    loader.dispose()
    childStores.disposeAll()
  })

  test("leaves older history loading to explicit viewport demand", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      return before
        ? response([createRecord(sessionID, "msg_older", 1)])
        : response([createRecord(sessionID, "msg_latest", 2)], "older-cursor")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { reason: "prefetch" })
    await Promise.resolve()

    expect(calls).toEqual([{ limit: 50, before: undefined }])
    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")

    await loader.loadOlder(target)

    expect(calls).toEqual([
      { limit: 50, before: undefined },
      { limit: 100, before: "older-cursor" },
    ])
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
      .toEqual(["msg_older", "msg_latest"])
    loader.dispose()
    childStores.disposeAll()
  })

  test("keeps a post-rollover tail ordered by sequence for every shared runtime", async () => {
    for (const runtimeKey of ["web", "desktop", "vscode", "mobile"]) {
      const childStores = new ChildStoreManager()
      const sdk = {
        session: {
          messages: async ({ sessionID }: { sessionID: string }) => response([
            createRecord(sessionID, "msg_000000000000Current2"),
            createRecord(sessionID, "msg_ffffffffffffLegacy1"),
          ]),
        },
      } as unknown as OpencodeClient
      const loader = new SessionMessageLoader(childStores, { sdk, runtimeKey })
      const target = { directory: `/repo-${runtimeKey}`, sessionID: "session-a" }

      await loader.ensure(target)

      expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]?.map((message) => message.id))
        .toEqual(["msg_ffffffffffffLegacy1", "msg_000000000000Current2"])
      loader.dispose()
      childStores.disposeAll()
    }
  })

  test("loads every history page for an explicit complete-history request", async () => {
    const calls: Array<{ before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (!before) return response([createRecord(sessionID, "msg_latest", 3)], "cursor-2")
      if (before === "cursor-2") return response([createRecord(sessionID, "msg_middle", 2)], "cursor-1")
      return response([createRecord(sessionID, "msg_oldest", 1)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.loadComplete(target)

    expect(calls).toEqual([
      { before: undefined },
      { before: "cursor-2" },
      { before: "cursor-1" },
    ])
    expect(loader.getSnapshot(target).complete).toBe(true)
    expect(childStores.getChild(target.directory)?.getState().message[target.sessionID]).toHaveLength(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when its initial load fails", async () => {
    const { childStores, loader } = createLoader(async () => ({
      error: { message: "rejected" },
      response: { status: 400 },
    }))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): rejected")

    loader.dispose()
    childStores.disposeAll()
  })

  test("rejects a complete-history request when an older page fails", async () => {
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => before
      ? { error: { message: "older rejected" }, response: { status: 400 } }
      : response([createRecord(sessionID)], "older-cursor"))
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("session.messages failed (400): older rejected")

    expect(loader.getSnapshot(target).cursor).toBe("older-cursor")
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries a failed older cursor on the next bounded lookup", async () => {
    let olderAttempts = 0
    const calls: Array<{ before?: string }> = []
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderAttempts += 1
      if (olderAttempts === 1) {
        return { error: { message: "older rejected" }, response: { status: 400 } }
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
      { before: undefined },
      { before: "cursor-a" },
      { before: "cursor-a" },
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
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls += 1
      if (!before) return response([createRecord(sessionID, "latest", 3)], "cursor-a")
      if (before === "cursor-a") return response([createRecord(sessionID, "middle", 2)], "cursor-b")
      return response([createRecord(sessionID, "older", 1)], "cursor-a")
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await expect(loader.loadComplete(target)).rejects.toThrow("Session history pagination made no progress")

    expect(calls).toBe(3)
    loader.dispose()
    childStores.disposeAll()
  })

  test("runs a requested tail refresh after an older in-flight load", async () => {
    const initial = deferred<ReturnType<typeof response>>()
    const refresh = deferred<ReturnType<typeof response>>()
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
    expect(limits).toEqual([50, 80])

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
    const calls: Array<{ directory?: string; before?: string }> = []
    const { childStores, loader } = createLoader(async ({ directory, before }) => {
      calls.push({ directory, before })
      return before
        ? response([createRecord(sessionID, `older-${directory}`)])
        : response([createRecord(sessionID, `latest-${directory}`)], `${directory}-cursor`)
    })

    await Promise.all([
      loader.ensure({ directory: providerDirectory, sessionID }),
      loader.ensure({ directory: selectedDirectory, sessionID }),
    ])
    calls.length = 0

    await loader.loadOlder({ directory: selectedDirectory, sessionID })

    expect(calls).toEqual([{
      directory: selectedDirectory,
      before: `${selectedDirectory}-cursor`,
    }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("exposes a retryable error without clearing an existing snapshot", async () => {
    let fail = true
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      if (fail) return { error: { message: "rejected" }, response: { status: 400 } }
      return response([createRecord(sessionID)])
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })
    store.setState({ message: { [target.sessionID]: [{ id: "cached", sessionID: target.sessionID, role: "user", time: { created: 0 } } as Message] } })

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
    const { childStores, loader } = createLoader(async () => ({
      error: { message: "network rejected" },
      response: { status: 0 },
    }))
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target, { force: true })

    expect((loader.getSnapshot(target).error as Error & { status?: number }).status).toBe(0)
    loader.dispose()
    childStores.disposeAll()
  })

  test("prevents an evicted in-flight request from repopulating the store", async () => {
    const pending = deferred<ReturnType<typeof response>>()
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
    const calls: Array<{ before?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    const loading = loader.loadOlder(target)
    await olderRequestStarted.promise

    loader.invalidateDirectory(target.directory)
    olderPage.resolve(response([createRecord(target.sessionID, "older", 1)], "cursor-b"))
    await loading

    expect(calls).toEqual([{ before: undefined }, { before: "cursor-a" }])
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not continue an older-page lookup after the session is invalidated", async () => {
    const calls: Array<{ before?: string }> = []
    const olderRequestStarted = deferred<void>()
    const olderPage = deferred<ReturnType<typeof response>>()
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      olderRequestStarted.resolve()
      return olderPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    const loading = loader.loadOlder(target)
    await olderRequestStarted.promise

    loader.invalidateSession(target)
    olderPage.resolve(response([createRecord(target.sessionID, "older", 1)], "cursor-b"))
    await loading

    expect(calls).toEqual([{ before: undefined }, { before: "cursor-a" }])
    expect(loader.getSnapshot(target).status).toBe("idle")
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not start an older page after directory invalidation while waiting for a tail refresh", async () => {
    const calls: Array<{ limit?: number; before?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, limit, before }) => {
      calls.push({ limit, before })
      if (before) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }
    const store = childStores.ensureChild(target.directory, { bootstrap: false })

    await loader.ensure(target)
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    loader.invalidateDirectory(target.directory)
    store.setState({ message: {}, part: {} })
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([
      { limit: 50, before: undefined },
      { limit: 20, before: undefined },
    ])
    expect(store.getState().message[target.sessionID]).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not recreate a disposed directory after waiting for a tail refresh", async () => {
    const calls: Array<{ before?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (before) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    expect(childStores.disposeDirectory(target.directory)).toBe(true)
    loader.invalidateDirectory(target.directory)
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([{ before: undefined }, { before: undefined }])
    expect(childStores.getChild(target.directory)).toBe(undefined)
    loader.dispose()
    childStores.disposeAll()
  })

  test("does not start another page after loader disposal while waiting for a tail refresh", async () => {
    const calls: Array<{ before?: string }> = []
    const refreshStarted = deferred<void>()
    const refreshPage = deferred<ReturnType<typeof response>>()
    let tailRequests = 0
    const { childStores, loader } = createLoader(async ({ sessionID, before }) => {
      calls.push({ before })
      if (before) return response([createRecord(sessionID, "unexpected-older", 1)])
      tailRequests += 1
      if (tailRequests === 1) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
      refreshStarted.resolve()
      return refreshPage.promise
    })
    const target = { directory: "/repo", sessionID: "session-a" }

    await loader.ensure(target)
    const refreshing = loader.refreshTail(target, 20)
    await refreshStarted.promise
    const loadingOlder = loader.loadOlder(target)

    loader.dispose()
    childStores.disposeAll()
    refreshPage.resolve(response([createRecord(target.sessionID, "refreshed", 3)], "ignored-refresh-cursor"))
    await Promise.all([refreshing, loadingOlder])

    expect(calls).toEqual([{ before: undefined }, { before: undefined }])
    expect(childStores.getChild(target.directory)).toBe(undefined)
  })

  test("retries initial coverage after an SDK transport switch for the same runtime", async () => {
    const oldInitial = deferred<ReturnType<typeof response>>()
    const oldCalls: Array<{ before?: string }> = []
    const newCalls: Array<{ before?: string }> = []
    const childStores = new ChildStoreManager()
    const oldSdk = {
      session: {
        messages: async ({ before }: { before?: string }) => {
          oldCalls.push({ before })
          return oldInitial.promise
        },
      },
    } as unknown as OpencodeClient
    const newSdk = {
      session: {
        messages: async ({ sessionID, before }: { sessionID: string; before?: string }) => {
          newCalls.push({ before })
          return before
            ? response([createRecord(sessionID, "target", 1)])
            : response([createRecord(sessionID, "latest", 2)], "cursor-a")
        },
      },
    } as unknown as OpencodeClient
    const loader = new SessionMessageLoader(childStores, { sdk: oldSdk, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-a" }
    childStores.ensureChild(target.directory, { bootstrap: false }).setState({
      message: { [target.sessionID]: [createRecord(target.sessionID, "cached", 0).info] },
    })
    await loader.ensure(target)
    expect(loader.getSnapshot(target).resolved).toBe(true)
    expect(loader.getSnapshot(target).cursor).toBe(undefined)
    const lookup = loader.loadUntil(target, { kind: "message", messageID: "target" })

    loader.configure({ sdk: newSdk, runtimeKey: "runtime-a" })
    oldInitial.resolve(response([createRecord(target.sessionID, "stale", 1)], "stale-cursor"))

    expect(await lookup).toBe(true)
    expect(oldCalls).toEqual([{ before: undefined }])
    expect(newCalls).toEqual([{ before: undefined }, { before: "cursor-a" }])
    loader.dispose()
    childStores.disposeAll()
  })

  test("retries an older cursor after an SDK transport switch for the same runtime", async () => {
    const oldOlderStarted = deferred<void>()
    const oldOlder = deferred<ReturnType<typeof response>>()
    const oldCalls: Array<{ before?: string }> = []
    const newCalls: Array<{ before?: string }> = []
    const childStores = new ChildStoreManager()
    const oldSdk = {
      session: {
        messages: async ({ sessionID, before }: { sessionID: string; before?: string }) => {
          oldCalls.push({ before })
          if (!before) return response([createRecord(sessionID, "latest", 2)], "cursor-a")
          oldOlderStarted.resolve()
          return oldOlder.promise
        },
      },
    } as unknown as OpencodeClient
    const newSdk = {
      session: {
        messages: async ({ sessionID, before }: { sessionID: string; before?: string }) => {
          newCalls.push({ before })
          return response([createRecord(sessionID, "target", 1)])
        },
      },
    } as unknown as OpencodeClient
    const loader = new SessionMessageLoader(childStores, { sdk: oldSdk, runtimeKey: "runtime-a" })
    const target = { directory: "/repo", sessionID: "session-a" }
    const lookup = loader.loadUntil(target, { kind: "message", messageID: "target" })

    await oldOlderStarted.promise
    loader.configure({ sdk: newSdk, runtimeKey: "runtime-a" })
    oldOlder.resolve(response([createRecord(target.sessionID, "stale-target", 1)]))

    expect(await lookup).toBe(true)
    expect(oldCalls).toEqual([{ before: undefined }, { before: "cursor-a" }])
    expect(newCalls).toEqual([{ before: "cursor-a" }])
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

  test("retries a missing message payload instead of treating it as an empty snapshot", async () => {
    let calls = 0
    const { childStores, loader } = createLoader(async ({ sessionID }) => {
      calls += 1
      return calls === 1 ? {} : response([createRecord(sessionID)])
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
      if (calls === 1) return {}
      if (calls === 2) {
        const assistant = createRecord(target.sessionID, "msg_assistant")
        assistant.info = { ...assistant.info, role: "assistant" } as Message
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
      expect(pageEvents.map((event) => event.requestLimit)).toEqual([50, 100])
      expect(pageEvents.map((event) => event.cursorPresent)).toEqual([false, false])
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
