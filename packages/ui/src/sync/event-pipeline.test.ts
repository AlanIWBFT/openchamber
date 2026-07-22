import { describe, expect, test } from "bun:test"
import type { Event, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createEventPipeline } from "./event-pipeline"

const failAfter = (ms: number) => new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error("Timed out waiting for event pipeline flush")), ms)
})

function partUpdatedEvent(text: string): Event {
  return {
    seq: 7,
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text,
      },
    },
  } as Event
}

function deltaEvent(delta: string): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta,
    },
  } as Event
}

function statusEvent(type: "busy" | "retry"): Event {
  return {
    type: "session.status",
    properties: {
      sessionID: "ses_1",
      status: type === "busy"
        ? { type }
        : { type, attempt: 1, message: "retrying", next: 1 },
    },
  } as Event
}

function sessionStatusEvent(type: "busy" | "idle"): Event {
  return {
    type: "session.status",
    properties: { sessionID: "ses_1", status: { type } },
  } as Event
}

function sessionTerminalEvent(type: "session.idle" | "session.error"): Event {
  return {
    type,
    properties: { sessionID: "ses_1" },
  } as Event
}

function sessionUpdatedEvent(title: string): Event {
  return {
    type: "session.updated",
    properties: { info: { id: "ses_1", title } },
  } as Event
}

function sessionArchivedEvent(): Event {
  return {
    type: "session.updated",
    properties: { info: { id: "ses_1", title: "archived", time: { archived: 1 } } },
  } as Event
}

function sessionLifecycleEvent(type: "session.created" | "session.deleted"): Event {
  return {
    type,
    properties: { sessionID: "ses_1", info: { id: "ses_1" } },
  } as Event
}

function partRemovedEvent(): Event {
  return {
    type: "message.part.removed",
    properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
  } as Event
}

function messageRemovedEvent(): Event {
  return {
    type: "message.removed",
    properties: { sessionID: "ses_1", messageID: "msg_1" },
  } as Event
}

function createSdk(events: Event[], streamFinished: () => void): OpencodeClient {
  return {
    global: {
      event: async ({ signal }: { signal: AbortSignal }) => ({
        stream: (async function* () {
          for (const payload of events) {
            yield { directory: "/repo", payload }
          }
          streamFinished()
          await new Promise<void>((resolve) => {
            if (signal.aborted) {
              resolve()
              return
            }
            signal.addEventListener("abort", () => resolve(), { once: true })
          })
        })(),
      }),
    },
  } as unknown as OpencodeClient
}

describe("createEventPipeline", () => {
  test("delivers one ordered batch per directory flush", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: (events: readonly Event[]) => void
    const deliveredBatch = new Promise<readonly Event[]>((resolve) => {
      resolveDelivered = resolve
    })
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
      ], resolveStreamFinished),
      onEvents: (_directory, events) => resolveDelivered([...events]),
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      const delivered = await Promise.race([deliveredBatch, failAfter(500)])
      expect(delivered.map((event) => event.type)).toEqual([
        "message.part.updated",
        "message.part.delta",
        "message.part.updated",
      ])
    } finally {
      pipeline.cleanup()
    }
  })

  test("does not coalesce session status across an idle barrier", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: (events: readonly Event[]) => void
    const deliveredBatch = new Promise<readonly Event[]>((resolve) => {
      resolveDelivered = resolve
    })
    const pipeline = createEventPipeline({
      sdk: createSdk([
        statusEvent("busy"),
        { type: "session.idle", properties: { sessionID: "ses_1" } } as Event,
        statusEvent("retry"),
      ], resolveStreamFinished),
      onEvents: (_directory, events) => resolveDelivered([...events]),
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      const delivered = await Promise.race([deliveredBatch, failAfter(500)])
      expect(delivered.map((event) => event.type)).toEqual([
        "session.status",
        "session.idle",
        "session.status",
      ])
      expect((delivered[2]?.properties as { status?: { type?: string } }).status?.type).toBe("retry")
    } finally {
      pipeline.cleanup()
    }
  })

  test("preserves part update order around text deltas", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 3) {
          resolveDelivered()
        }
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

    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["updated:a", "delta:b", "updated:ab"])
    expect((delivered[0] as { seq?: number }).seq).toBe(7)
  })

  test("does not merge deltas across an intervening part snapshot", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        partUpdatedEvent("a"),
        deltaEvent("b"),
        partUpdatedEvent("ab"),
        deltaEvent("c"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 4) {
          resolveDelivered()
        }
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      await Promise.race([deliveredAll, new Promise<void>((resolve) => setTimeout(resolve, 300))])
    } finally {
      pipeline.cleanup()
    }

    // The "ab" snapshot is a coalescing barrier: the trailing "c" delta must
    // stay a separate event after it, not merge into the "b" delta queued
    // before the snapshot (which the snapshot would then overwrite).
    expect(delivered.map((event) => {
      if (event.type === "message.part.delta") {
        return `delta:${(event.properties as { delta: string }).delta}`
      }
      return `updated:${((event.properties as { part: { text: string } }).part).text}`
    })).toEqual(["updated:a", "delta:b", "updated:ab", "delta:c"])
  })

  for (const removal of [partRemovedEvent, messageRemovedEvent]) {
    test(`does not merge deltas across ${removal().type}`, async () => {
      let resolveStreamFinished!: () => void
      const streamFinished = new Promise<void>((resolve) => {
        resolveStreamFinished = resolve
      })
      let resolveDelivered!: () => void
      const deliveredAll = new Promise<void>((resolve) => {
        resolveDelivered = resolve
      })
      const delivered: Event[] = []
      const pipeline = createEventPipeline({
        sdk: createSdk([deltaEvent("a"), removal(), deltaEvent("b")], resolveStreamFinished),
        onEvent: (_directory, payload) => {
          delivered.push(payload)
          if (delivered.length === 3) resolveDelivered()
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

      expect(delivered.map((event) => event.type === "message.part.delta"
        ? `delta:${(event.properties as { delta: string }).delta}`
        : event.type)).toEqual(["delta:a", removal().type, "delta:b"])
    })
  }

  for (const terminalType of ["session.idle", "session.error"] as const) {
    test(`preserves status order across ${terminalType}`, async () => {
      let resolveStreamFinished!: () => void
      const streamFinished = new Promise<void>((resolve) => {
        resolveStreamFinished = resolve
      })
      let resolveDelivered!: () => void
      const deliveredAll = new Promise<void>((resolve) => {
        resolveDelivered = resolve
      })
      const delivered: Event[] = []
      const pipeline = createEventPipeline({
        sdk: createSdk([
          sessionStatusEvent("busy"),
          sessionTerminalEvent(terminalType),
          sessionStatusEvent("busy"),
        ], resolveStreamFinished),
        onEvent: (_directory, payload) => {
          delivered.push(payload)
          if (delivered.length === 3) resolveDelivered()
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

      expect(delivered.map((event) => event.type)).toEqual([
        "session.status",
        terminalType,
        "session.status",
      ])
    })
  }

  for (const lifecycleType of ["session.created", "session.deleted"] as const) {
    test(`preserves session updates and statuses across ${lifecycleType}`, async () => {
      let resolveStreamFinished!: () => void
      const streamFinished = new Promise<void>((resolve) => {
        resolveStreamFinished = resolve
      })
      let resolveDelivered!: () => void
      const deliveredAll = new Promise<void>((resolve) => {
        resolveDelivered = resolve
      })
      const delivered: Event[] = []
      const pipeline = createEventPipeline({
        sdk: createSdk([
          sessionUpdatedEvent("before"),
          sessionStatusEvent("busy"),
          sessionLifecycleEvent(lifecycleType),
          sessionUpdatedEvent("after"),
          sessionStatusEvent("idle"),
        ], resolveStreamFinished),
        onEvent: (_directory, payload) => {
          delivered.push(payload)
          if (delivered.length === 5) resolveDelivered()
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

      expect(delivered.map((event) => event.type)).toEqual([
        "session.updated",
        "session.status",
        lifecycleType,
        "session.updated",
        "session.status",
      ])
    })
  }

  test("preserves session updates across an archived lifecycle update", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        sessionUpdatedEvent("before"),
        sessionStatusEvent("busy"),
        sessionArchivedEvent(),
        sessionUpdatedEvent("after"),
        sessionStatusEvent("idle"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 5) resolveDelivered()
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

    expect(delivered.map((event) => event.type)).toEqual([
      "session.updated",
      "session.status",
      "session.updated",
      "session.updated",
      "session.status",
    ])
    expect((delivered[2].properties as { info: { time?: { archived?: number } } }).info.time?.archived).toBe(1)
  })

  test("does not merge deltas across a session lifecycle event", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: () => void
    const deliveredAll = new Promise<void>((resolve) => {
      resolveDelivered = resolve
    })
    const delivered: Event[] = []
    const pipeline = createEventPipeline({
      sdk: createSdk([
        deltaEvent("before"),
        sessionLifecycleEvent("session.deleted"),
        deltaEvent("after"),
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        delivered.push(payload)
        if (delivered.length === 3) resolveDelivered()
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

    expect(delivered.map((event) => event.type === "message.part.delta"
      ? `delta:${(event.properties as { delta: string }).delta}`
      : event.type)).toEqual(["delta:before", "session.deleted", "delta:after"])
  })

  test("normalizes openchamber session status events", async () => {
    let resolveStreamFinished!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      resolveStreamFinished = resolve
    })
    let resolveDelivered!: (event: Event) => void
    const deliveredEvent = new Promise<Event>((resolve) => {
      resolveDelivered = resolve
    })
    const pipeline = createEventPipeline({
      sdk: createSdk([
        {
          type: "openchamber:session-status",
          properties: {
            sessionID: "ses_1",
            status: "idle",
          },
        } as unknown as Event,
      ], resolveStreamFinished),
      onEvent: (_directory, payload) => {
        resolveDelivered(payload)
      },
      transport: "sse",
      heartbeatTimeoutMs: 1_000,
    })

    try {
      await streamFinished
      const delivered = await Promise.race([deliveredEvent, failAfter(500)])
      expect(delivered.type).toBe("session.status")
      expect(delivered.properties).toEqual({
        sessionID: "ses_1",
        status: { type: "idle" },
      })
    } finally {
      pipeline.cleanup()
    }
  })
})
