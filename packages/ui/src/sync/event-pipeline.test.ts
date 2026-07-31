import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { OpenCode, type JsonValue, type OpenCodeClient, type OpenCodeEvent } from "@opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
import { adoptRelayTunnel, deactivateRelayTunnel } from "@/lib/relay/runtime-tunnel"
import type { RelayTunnelClient, RelayTunnelWebSocket } from "@/lib/relay/tunnel-client"
import { clearRuntimeUrlAuthToken, setRuntimeUrlAuthToken } from "@/lib/runtime-auth"
import { createEventPipeline } from "./event-pipeline"

const failAfter = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
})

const base = { id: "evt_1", created: 1000, location: { directory: "/repo" } }
const durable = { aggregateID: "ses_1", seq: 1, version: 1 as const }

function textEnded(text: string): OpenCodeEvent {
  return { ...base, type: "session.text.ended", durable, data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, text } }
}

function textDelta(delta: string): OpenCodeEvent {
  return { ...base, type: "session.text.delta", data: { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0, delta } }
}

function statusEvent(type: "busy" | "retry"): OpenCodeEvent {
  return {
    ...base,
    type: "session.status",
    data: {
      sessionID: "ses_1",
      status: type === "busy" ? { type } : { type, attempt: 1, message: "retrying", next: 1 },
    },
  }
}

/** A raw stream payload: wire events, or OpenChamber's own bridge events. */
type StreamPayload = OpenCodeEvent | { type: string; properties: Record<string, JsonValue> }

/** `keepalives` counts SSE comments sent before the events. They are activity without an event. */
function createSdk(events: StreamPayload[], streamFinished: () => void, keepalives = 0): OpenCodeClient {
  const subscribe = ({ signal, onActivity }: { signal?: AbortSignal; onActivity?: () => void }) => ({
    async *[Symbol.asyncIterator]() {
      for (let sent = 0; sent < keepalives; sent += 1) {
        onActivity?.()
      }
      for (const payload of events) {
        yield payload as OpenCodeEvent
      }
      streamFinished()
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve()
          return
        }
        signal.addEventListener("abort", () => resolve(), { once: true })
      })
    },
  })
  // SAFETY: the pipeline only touches `event.subscribe` on the client.
  return { event: { subscribe } } as unknown as OpenCodeClient
}

const describeEvent = (event: SyncEvent): string => {
  if (event.type === "message.part.delta") return `delta:${event.properties.delta}`
  if (event.type === "message.part.updated" && event.properties.part.type === "text") return `updated:${event.properties.part.text}`
  return event.type
}

async function collect(events: StreamPayload[], expected: number): Promise<{ directory: string; events: SyncEvent[] }> {
  let resolveStreamFinished!: () => void
  const streamFinished = new Promise<void>((resolve) => {
    resolveStreamFinished = resolve
  })
  let resolveDelivered!: () => void
  const deliveredAll = new Promise<void>((resolve) => {
    resolveDelivered = resolve
  })
  const delivered: SyncEvent[] = []
  let deliveredDirectory = ""
  const pipeline = createEventPipeline({
    sdk: createSdk(events, resolveStreamFinished),
    onEvents: (directory, batch) => {
      deliveredDirectory = directory
      delivered.push(...batch)
      if (delivered.length >= expected) resolveDelivered()
    },
    transport: "sse",
    heartbeatTimeoutMs: 1_000,
  })
  try {
    await streamFinished
    await Promise.race([deliveredAll, failAfter(500)])
  } finally {
    pipeline.cleanup()
  }
  return { directory: deliveredDirectory, events: delivered }
}

describe("createEventPipeline", () => {
  test("a clean V2 SSE EOF enters pipeline recovery without claiming a connection", async () => {
    let resolveDisconnected!: (reason: string) => void
    const disconnected = new Promise<string>((resolve) => { resolveDisconnected = resolve })
    let connected = 0
    let requests = 0
    const sdk = OpenCode.make({ baseUrl: "http://localhost", fetch: async () => {
      requests++
      return new Response("", { headers: { "content-type": "text/event-stream" } })
    } })
    const pipeline = createEventPipeline({
      sdk, transport: "sse", onEvent: () => {},
      onDisconnect: resolveDisconnected, onReconnect: () => { connected++ },
    })
    try {
      expect(await Promise.race([disconnected, failAfter(500)])).toBe("sse_closed")
      expect(requests).toBe(1)
      expect(connected).toBe(0)
    } finally {
      pipeline.cleanup()
    }
  })

  test("preserves native retry error resolution on the assistant message", async () => {
    const error = { type: "rate_limit", message: "Rate limited", resolution: { kind: "rate_limited", retry: "automatic", action: "wait" } } as const
    const { events } = await collect([{
      ...base, durable, type: "session.retry.scheduled",
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", attempt: 2, at: 2000, error },
    }], 1)
    expect(events).toEqual([{
      type: "message.patched", properties: { sessionID: "ses_1", messageID: "msg_1", patch: { retry: { attempt: 2, at: 2000, error } } },
    }])
  })

  test("preserves validated retry actions from the host bridge", async () => {
    const action = { reason: "rate_limited", provider: "openai", title: "Rate limited", message: "Wait and retry", label: "Wait" }
    const { events } = await collect([{
      type: "openchamber:session-status", properties: {
        sessionId: "ses_1", status: "retry", metadata: { attempt: 1, message: "retrying", next: 10, action },
      },
    }], 1)
    expect(events).toEqual([{
      type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "retrying", next: 10, action } },
    }])
  })

  test("an invalid optional host action does not discard valid retry status", async () => {
    const { events } = await collect([{
      type: "openchamber:session-status", properties: {
        sessionId: "ses_1", status: "retry", metadata: { attempt: 1, message: "retrying", next: 10, action: { title: 4 } },
      },
    }], 1)
    expect(events).toEqual([{
      type: "session.status", properties: { sessionID: "ses_1", status: { type: "retry", attempt: 1, message: "retrying", next: 10 } },
    }])
  })

  test("translates wire events, routes them by location, and delivers one ordered batch", async () => {
    const { directory, events } = await collect([textEnded("a"), textDelta("b"), textEnded("ab")], 3)
    expect(directory).toBe("/repo")
    expect(events.map(describeEvent)).toEqual(["updated:a", "delta:b", "updated:ab"])
  })

  test("merges consecutive deltas for one part", async () => {
    const { events } = await collect([textEnded(""), textDelta("b"), textDelta("c")], 2)
    expect(events.map(describeEvent)).toEqual(["updated:", "delta:bc"])
  })

  test("does not merge deltas across an intervening part snapshot", async () => {
    // The "ab" snapshot is a coalescing barrier: the trailing "c" delta must
    // stay a separate event after it, not merge into the "b" delta queued
    // before the snapshot (which the snapshot would then overwrite).
    const { events } = await collect([textEnded("a"), textDelta("b"), textEnded("ab"), textDelta("c")], 4)
    expect(events.map(describeEvent)).toEqual(["updated:a", "delta:b", "updated:ab", "delta:c"])
  })

  test("does not coalesce session status across an idle barrier", async () => {
    const { events } = await collect(
      [statusEvent("busy"), { ...base, type: "session.idle", data: { sessionID: "ses_1" } }, statusEvent("retry")],
      3,
    )
    expect(events.map((event) => event.type)).toEqual(["session.status", "session.idle", "session.status"])
    const last = events[2]
    expect(last.type === "session.status" && last.properties.status.type).toBe("retry")
  })

  test("does not merge deltas across cancellation of their message", async () => {
    const { events } = await collect([
      textDelta("a"),
      { ...base, type: "session.inbox.cancelled", durable, data: { sessionID: "ses_1", inboxID: "msg_1" } },
      textDelta("b"),
    ], 3)
    expect(events.map(describeEvent)).toEqual(["delta:a", "message.removed", "delta:b"])
  })

  test("does not merge deltas across session deletion", async () => {
    const { events } = await collect([
      textDelta("a"),
      { ...base, type: "session.deleted", durable: { ...durable, version: 2 }, data: { sessionID: "ses_1" } },
      textDelta("b"),
    ], 3)
    expect(events.map(describeEvent)).toEqual(["delta:a", "session.deleted", "delta:b"])
  })

  test("preserves status order across failure", async () => {
    const { events } = await collect([
      statusEvent("busy"),
      { ...base, type: "session.execution.failed", durable, data: { sessionID: "ses_1", error: { type: "provider", message: "failed" } } },
      statusEvent("retry"),
    ], 4)
    expect(events.map((event) => event.type)).toEqual(["session.status", "session.patched", "session.error", "session.status"])
  })

  for (const type of ["session.created", "session.deleted"] as const) {
    test(`preserves updates and statuses across ${type}`, async () => {
      const lifecycle: OpenCodeEvent = type === "session.deleted"
        ? { ...base, type, durable: { ...durable, version: 2 }, data: { sessionID: "ses_1" } }
        : { ...base, type, durable, data: { sessionID: "ses_1", projectID: "project", slug: "one", location: { directory: "/repo" }, version: "2.0.15" } }
      const { events } = await collect([
        { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "before" } },
        statusEvent("busy"), lifecycle,
        { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "after" } },
        statusEvent("retry"),
      ], 5)
      expect(events.map((event) => event.type)).toEqual(["session.patched", "session.status", type, "session.patched", "session.status"])
    })
  }

  test("preserves archive and restore as separate lifecycle transitions", async () => {
    const { events } = await collect([
      { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "before" } },
      statusEvent("busy"),
      { ...base, type: "session.archive.updated", durable, data: { sessionID: "ses_1", archivedAt: 1 } },
      { ...base, type: "session.archive.updated", durable, data: { sessionID: "ses_1", archivedAt: null } },
      { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "after" } },
      statusEvent("retry"),
    ], 6)
    expect(events[2]).toMatchObject({ type: "session.patched", properties: { patch: { time: { archived: 1 } } } })
    expect(events[3]).toMatchObject({ type: "session.patched", properties: { patch: { time: { archived: null } } } })
    expect(events[4]).toMatchObject({ type: "session.patched", properties: { patch: { title: "after" } } })
  })

  test("does not move a retried step's completion before its new start", async () => {
    const ended: OpenCodeEvent = {
      ...base, type: "session.step.ended", durable,
      data: { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
    }
    const { events } = await collect([
      ended,
      { ...base, type: "session.step.started", durable, data: { sessionID: "ses_1", assistantMessageID: "msg_1", agent: "build", model: { providerID: "test", id: "test" }, started: 1000 } },
      ended,
    ], 3)
    expect(events.map((event) => event.type)).toEqual(["message.patched", "message.updated", "message.patched"])
  })

  test("folds successive session patches into one", async () => {
    const { events } = await collect(
      [
        { ...base, type: "session.renamed", durable, data: { sessionID: "ses_1", title: "New" } },
        { ...base, type: "session.usage.updated", data: { sessionID: "ses_1", cost: 1, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } } },
      ],
      1,
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: "session.patched", properties: { patch: { title: "New", cost: 1, time: { updated: 1000 } } } })
  })

  test("bridges openchamber session status events into session.status", async () => {
    const { directory, events } = await collect(
      [{ type: "openchamber:session-status", properties: { sessionID: "ses_1", status: "idle" } }],
      1,
    )
    expect(directory).toBe("global")
    expect(events[0]).toEqual({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "idle" } } })
  })

  test("bridges openchamber archive announcements into session patches", async () => {
    const { events } = await collect(
      [{ type: "openchamber:session-archived", properties: { sessionID: "ses_1", archivedAt: 42 } as never }],
      1,
    )
    expect(events[0]).toEqual({ type: "session.patched", properties: { sessionID: "ses_1", patch: { time: { archived: 42 } } } })
  })

  test("bridges openchamber metadata announcements into session patches", async () => {
    const { events } = await collect(
      [{ type: "openchamber:session-metadata", properties: { sessionID: "ses_1", metadata: { pinned: true } } as never }],
      1,
    )
    expect(events[0]).toEqual({ type: "session.patched", properties: { sessionID: "ses_1", patch: { metadata: { pinned: true } } } })
  })

  test("passes OpenChamber notification and auto-accept frames through typed", async () => {
    const { events } = await collect(
      [
        { type: "openchamber:notification", properties: { kind: "agent-complete", sessionId: "ses_1", title: "Done" } },
        { type: "openchamber:permission-auto-accept.updated", properties: { sessions: { ses_1: true }, modes: { ses_1: "safety" }, revision: 3 } as never },
      ],
      2,
    )
    expect(events[0]).toEqual({ type: "openchamber.notification", properties: { kind: "agent-complete", sessionId: "ses_1", title: "Done" } })
    expect(events[1]).toEqual({ type: "openchamber.permission-auto-accept", properties: { sessions: { ses_1: true }, modes: { ses_1: "safety" }, revision: 3 } })
  })

  test("ignores payloads that are neither wire events nor bridge events", async () => {
    const { events } = await collect([{ type: "something.else", properties: {} }, textEnded("x")], 1)
    expect(events.map(describeEvent)).toEqual(["updated:x"])
  })

  test("hands a space-stream announcement to its owner and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const announced: Array<{ spaceId: string; status: string; wasReady: boolean }> = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-stream", properties: { spaceId: "a1b2c3d4e5f6", status: "connected", wasReady: false, timestamp: 1 } as never },
        { type: "openchamber:space-stream", properties: { spaceId: "not-an-id", status: "connected", wasReady: false } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceStream: (details) => { announced.push(details) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(announced).toEqual([{ spaceId: "a1b2c3d4e5f6", status: "connected", wasReady: false }])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("hands a creation step of a space to its owner, failure included, and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const steps: Array<{ spaceId: string; step: string; failure: { code: string; message: string } | null }> = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "creating", failure: null, timestamp: 1 } as never },
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "failed", failure: { code: "docker_daemon_unreachable", message: "down", details: null }, timestamp: 2 } as never },
        { type: "openchamber:space-progress", properties: { spaceId: "a1b2c3d4e5f6", step: "dancing", failure: null } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceProgress: (progress) => { steps.push(progress) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(steps).toEqual([
      { spaceId: "a1b2c3d4e5f6", step: "creating", failure: null },
      { spaceId: "a1b2c3d4e5f6", step: "failed", failure: { code: "docker_daemon_unreachable", message: "down" } },
    ])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("hands a move of a space's setup commands to its owner and delivers no event for it", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    const moved: string[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        { type: "openchamber:space-setup", properties: { spaceId: "a1b2c3d4e5f6", timestamp: 1 } as never },
        { type: "openchamber:space-setup", properties: { spaceId: "../etc" } as never },
        textEnded("a"),
      ], resolveStreamFinished),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onSpaceSetup: (spaceId) => { moved.push(spaceId) },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(moved).toEqual(["a1b2c3d4e5f6"])
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("reports keepalives that carry no event as stream activity", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    const delivered: SyncEvent[] = []
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([textEnded("a")], resolveStreamFinished, 2),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onStreamActivity: () => { activity += 1 },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    // Two keepalives and one event; only the event is delivered.
    expect(activity).toBe(3)
    expect(delivered.map(describeEvent)).toEqual(["updated:a"])
  })

  test("reports no stream activity for an attempt that has received nothing", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => { resolveStreamFinished = resolve })
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], resolveStreamFinished),
      onEvents: () => undefined,
      onStreamActivity: () => { activity += 1 },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      await streamFinished
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    expect(activity).toBe(0)
  })
})

/** A relay tunnel socket the test drives by hand. */
function createFakeSocket(): RelayTunnelWebSocket {
  let readyState = 1
  return {
    get readyState() { return readyState },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send: () => undefined,
    close: () => { readyState = 3 },
  }
}

describe("createEventPipeline over the WebSocket transport", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      value: Object.assign(new EventTarget(), { location: new URL("http://runtime.test") }),
      configurable: true,
      writable: true,
    })
    // A valid URL token lets the attempt open the socket without minting one.
    setRuntimeUrlAuthToken("fixture-url-token", Date.now() + 10 * 60_000)
  })

  afterEach(() => {
    deactivateRelayTunnel()
    clearRuntimeUrlAuthToken()
    Reflect.deleteProperty(globalThis, "window")
  })

  test("counts a heartbeat frame as stream activity without delivering an event", async () => {
    const paths: string[] = []
    const sockets: RelayTunnelWebSocket[] = []
    const tunnel: RelayTunnelClient = {
      async fetch() { throw new Error("the WebSocket transport must not fetch") },
      openWebSocket(pathWithQuery) {
        paths.push(pathWithQuery)
        const socket = createFakeSocket()
        sockets.push(socket)
        return socket
      },
      getStatus: () => ({ state: "connected" }),
      subscribeStatus: () => () => undefined,
      close: () => undefined,
    }
    adoptRelayTunnel({ relayUrl: "wss://relay.test", serverId: "fixture", hostEncPubJwk: {} }, tunnel)
    const delivered: SyncEvent[] = []
    let activity = 0
    const pipeline = createEventPipeline({
      sdk: createSdk([], () => undefined),
      onEvents: (_directory, batch) => { delivered.push(...batch) },
      onStreamActivity: () => { activity += 1 },
      transport: "ws",
      heartbeatTimeoutMs: 1_000,
    })
    try {
      for (let i = 0; i < 20 && sockets.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sockets).toHaveLength(1)
      expect(paths[0]).toContain("/api/global/event/ws")
      const socket = sockets[0]
      socket.onmessage?.({ data: JSON.stringify({ type: "ready" }) })
      socket.onmessage?.({
        data: JSON.stringify({ type: "event", payload: { type: "openchamber:heartbeat", timestamp: 1 }, directory: "global" }),
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } finally {
      pipeline.cleanup()
    }
    // The ready frame and the heartbeat frame both prove the socket is alive. Neither is an event.
    expect(activity).toBe(2)
    expect(delivered).toEqual([])
  })
})
