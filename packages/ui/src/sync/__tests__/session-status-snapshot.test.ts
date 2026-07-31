import { describe, expect, test } from "bun:test"
import { create, type StoreApi } from "zustand"
import type { OpencodeClient, Project, SessionStatus } from "@opencode-ai/sdk/v2/client"

import { INITIAL_STATE, type State } from "../types"
import type { DirectoryStore } from "../child-store"
import { bootstrapDirectory } from "../bootstrap"
import {
  applySessionStatusSnapshot,
  createSessionStatusRequestCoordinator,
  needsSnapshotAfterStatusPoll,
  shouldTriggerStaleResync,
} from "../sync-context"

type StatusSnapshot = Record<string, SessionStatus>

function createDirectoryStore(initial: Partial<State>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...initial,
    session: initial.session ?? [],
    session_status_ready: initial.session_status_ready ?? true,
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }))
}

function streamingMessage() {
  // Trailing assistant message with no `time.completed` → actively streaming.
  return [{ id: "msg_1", role: "assistant", time: { created: 1 } }] as unknown as State["message"][string]
}

function completedMessage() {
  return [{ id: "msg_1", role: "assistant", time: { created: 1, completed: 2 } }] as unknown as State["message"][string]
}

const BUSY: SessionStatus = { type: "busy" }

describe("session status request coordinator", () => {
  test("rejects only responses older than an already applied response", () => {
    const begin = createSessionStatusRequestCoordinator()
    const store = {}

    const first = begin(store)
    const second = begin(store)
    expect(first()).toBe(true)
    expect(second()).toBe(true)

    const older = begin(store)
    const newer = begin(store)
    expect(newer()).toBe(true)
    expect(older()).toBe(false)

    const successfulBeforeFailure = begin(store)
    begin(store) // The newer request fails and never attempts to apply.
    expect(successfulBeforeFailure()).toBe(true)
  })
})

describe("applySessionStatusSnapshot", () => {
  test("marks even an empty successful snapshot as resolved", () => {
    const store = createDirectoryStore({ session_status_ready: false })
    const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, [], "monotonic")
    expect(changed).toBe(true)
    expect(store.getState().session_status_ready).toBe(true)
  })

  test("ingests active sessions outside the recovery candidate set", () => {
    const store = createDirectoryStore({ session_status: {}, session_status_ready: false })
    applySessionStatusSnapshot(store, { ses_active: { type: "busy" } }, [], "monotonic")
    expect(store.getState().session_status.ses_active).toEqual(BUSY)
    expect(store.getState().session_status_ready).toBe(true)
  })

  test("preserves a newer status transition that lands during the request", () => {
    const original = { type: "busy" } as SessionStatus
    const store = createDirectoryStore({ session_status: { ses_a: original } })
    const baseline = store.getState().session_status
    store.setState({ session_status: { ses_a: { type: "idle" } } })

    applySessionStatusSnapshot(
      store,
      { ses_a: { type: "retry", attempt: 2, message: "old", next: 30 } },
      ["ses_a"],
      "authoritative",
      baseline,
    )

    expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
  })

  describe("monotonic mode (periodic poll)", () => {
    test("does NOT lower a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "monotonic")
      expect(changed).toBe(false)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("does NOT lower a busy session even when the snapshot reports it idle", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      applySessionStatusSnapshot(store, { ses_a: { type: "idle" } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("raises an idle/unknown session to busy when the snapshot reports it active (missed event)", () => {
      const store = createDirectoryStore({ session_status: {} })
      const changed = applySessionStatusSnapshot(store, { ses_a: { type: "busy" } }, ["ses_a"], "monotonic")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual(BUSY)
    })

    test("establishes idle for an unknown heuristic candidate without lowering active state", () => {
      const store = createDirectoryStore({ session_status: {} })
      applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("updates busy → retry from the snapshot", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const retry: SessionStatus = { type: "retry", attempt: 2, message: "x", next: 30 }
      applySessionStatusSnapshot(store, { ses_a: { type: "retry", attempt: 2, message: "x", next: 30 } }, ["ses_a"], "monotonic")
      expect(store.getState().session_status.ses_a).toEqual(retry)
    })

    test("preserves retry recovery metadata from the snapshot", () => {
      const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
      const retry: SessionStatus = {
        type: "retry",
        attempt: 2,
        message: "rate limited",
        next: 30,
        resolution: { kind: "rate_limited", retry: "automatic", action: "wait" },
      }

      applySessionStatusSnapshot(store, { ses_a: retry }, ["ses_a"], "monotonic")

      expect(store.getState().session_status.ses_a).toEqual(retry)
    })
  })

  describe("authoritative mode (reconnect / escalated resync)", () => {
    test("lowers a busy session to idle when the snapshot omits it", () => {
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: completedMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })

    test("snapshot is the source of truth: lowers to idle even if the trailing message looks unfinished", () => {
      // The live /session/status snapshot wins over derived message state — a
      // stale/lost message.updated must never pin a session busy after the
      // server says idle. (Recovery from a missed idle event.)
      const store = createDirectoryStore({
        session_status: { ses_a: BUSY },
        message: { ses_a: streamingMessage() },
      })
      const changed = applySessionStatusSnapshot(store, {} as StatusSnapshot, ["ses_a"], "authoritative")
      expect(changed).toBe(true)
      expect(store.getState().session_status.ses_a).toEqual({ type: "idle" })
    })
  })
})

type BootstrapStatusResult = { data?: StatusSnapshot; error?: unknown; response?: { status?: number } }

function createBootstrapSdk(statusResult: BootstrapStatusResult | Promise<BootstrapStatusResult>) {
  const result = <T,>(data: T) => Promise.resolve({ data })
  return {
    config: { get: () => result({}) },
    path: { get: () => result({ state: "", config: "", worktree: "", directory: "C:/repo", home: "" }) },
    session: { status: () => Promise.resolve(statusResult) },
    command: { list: () => result([]) },
    mcp: { status: () => result({}) },
    lsp: { status: () => result([]) },
    vcs: { get: () => result(undefined) },
    question: { list: () => result([]) },
    permission: { list: () => result([]) },
  } as unknown as OpencodeClient
}

function startBootstrap(
  statusResult: BootstrapStatusResult | Promise<BootstrapStatusResult>,
  beginSessionStatusRequest?: () => () => boolean,
) {
  let state: State = { ...INITIAL_STATE }
  const promise = bootstrapDirectory({
    directory: "C:/repo",
    sdk: createBootstrapSdk(statusResult),
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch } },
    global: {
      config: {},
      projects: [{ id: "project", worktree: "C:/repo" } as Project],
    },
    beginSessionStatusRequest,
    loadSessions: () => undefined,
  })
  return {
    promise,
    getState: () => state,
    setState: (patch: Partial<State>) => { state = { ...state, ...patch } },
  }
}

async function bootstrapWithStatus(statusResult: BootstrapStatusResult) {
  const bootstrap = startBootstrap(statusResult)
  await bootstrap.promise
  return bootstrap.getState()
}

describe("bootstrapDirectory session status", () => {
  test("marks a successful empty status snapshot as resolved", async () => {
    const state = await bootstrapWithStatus({ data: {} })
    expect(state.session_status_ready).toBe(true)
    expect(state.session_status).toEqual({})
  })

  test("preserves unresolved status when the status request fails", async () => {
    const state = await bootstrapWithStatus({
      error: new Error("status unavailable"),
      response: { status: 400 },
    })
    expect(state.status).toBe("complete")
    expect(state.session_status_ready).toBe(false)
  })

  test("does not overwrite a newer status while the snapshot is in flight", async () => {
    let resolveStatus!: (result: BootstrapStatusResult) => void
    const statusResult = new Promise<BootstrapStatusResult>((resolve) => {
      resolveStatus = resolve
    })
    const bootstrap = startBootstrap(statusResult)
    bootstrap.setState({ session_status: { ses_a: { type: "busy" } } })
    resolveStatus({
      data: { ses_a: { type: "retry", attempt: 1, message: "older", next: 10 } },
    })
    await bootstrap.promise

    expect(bootstrap.getState().session_status.ses_a).toEqual({ type: "busy" })
    expect(bootstrap.getState().session_status_ready).toBe(true)
  })

  test("ignores a snapshot superseded by a newer directory request", async () => {
    const bootstrap = startBootstrap(
      { data: { ses_a: { type: "busy" } } },
      () => () => false,
    )
    await bootstrap.promise

    expect(bootstrap.getState().session_status).toEqual({})
    expect(bootstrap.getState().session_status_ready).toBe(false)
  })
})

describe("needsSnapshotAfterStatusPoll", () => {
  test("escalates when the store says busy but the snapshot omits it", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: completedMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("escalates regardless of a still-streaming trailing message (snapshot drives recovery)", () => {
    const store = createDirectoryStore({
      session_status: { ses_a: BUSY },
      message: { ses_a: streamingMessage() },
    })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(true)
  })

  test("does NOT escalate when the snapshot confirms the session is active", () => {
    const store = createDirectoryStore({ session_status: { ses_a: BUSY } })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", { type: "busy" })).toBe(false)
  })

  test("does NOT escalate when the store already considers the session idle", () => {
    const store = createDirectoryStore({ session_status: {} })
    expect(needsSnapshotAfterStatusPoll(store.getState(), "ses_a", undefined)).toBe(false)
  })
})

describe("shouldTriggerStaleResync", () => {
  const STALE_MS = 20_000
  const COOLDOWN_MS = 15_000

  test("does NOT trigger when heartbeats are recent (quiet-but-connected session)", () => {
    // 5s ago a heartbeat arrived — stream is alive even though no meaningful
    // events came through. This is the core fix for issue #1656.
    const now = 100_000
    const lastStreamActivityAt = now - 5_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("does NOT trigger when a non-heartbeat event is recent", () => {
    const now = 100_000
    const lastStreamActivityAt = now - 3_000
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when no events at all (including heartbeats) for the stale threshold", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, 0, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when within the resync cooldown even if stream is stale", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - 5_000 // only 5s ago, cooldown is 15s
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("triggers when stream is stale AND cooldown has elapsed", () => {
    const now = 100_000
    const lastStreamActivityAt = now - STALE_MS - 1
    const lastFullResyncAt = now - COOLDOWN_MS - 1
    expect(shouldTriggerStaleResync(lastStreamActivityAt, lastFullResyncAt, now, STALE_MS, COOLDOWN_MS)).toBe(true)
  })

  test("does NOT trigger when no events have been received yet (lastStreamActivityAt is 0)", () => {
    // Prevents firing before the first heartbeat arrives
    expect(shouldTriggerStaleResync(0, 0, 100_000, STALE_MS, COOLDOWN_MS)).toBe(false)
  })

  test("uses default thresholds when omitted", () => {
    const now = 100_000
    // 25s since last activity (> 20s default), 20s since last resync (> 15s default)
    expect(shouldTriggerStaleResync(now - 25_000, now - 20_000, now)).toBe(true)
    // 10s since last activity (< 20s default)
    expect(shouldTriggerStaleResync(now - 10_000, 0, now)).toBe(false)
  })
})
