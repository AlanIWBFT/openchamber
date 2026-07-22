import { describe, expect, test } from "bun:test"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import type { SyncEvent } from "@/lib/opencode/events"
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
type StreamPayload = OpenCodeEvent | { type: string; properties: Record<string, string> }

function createSdk(events: StreamPayload[], streamFinished: () => void): OpenCodeClient {
  const subscribe = ({ signal }: { signal?: AbortSignal }) => ({
    async *[Symbol.asyncIterator]() {
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
        { type: "openchamber:permission-auto-accept.updated", properties: { sessions: { ses_1: true }, revision: 3 } as never },
      ],
      2,
    )
    expect(events[0]).toEqual({ type: "openchamber.notification", properties: { kind: "agent-complete", sessionId: "ses_1", title: "Done" } })
    expect(events[1]).toEqual({ type: "openchamber.permission-auto-accept", properties: { sessions: { ses_1: true }, revision: 3 } })
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
})
