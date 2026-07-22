import { describe, expect, test } from "bun:test"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import {
  getSessionMaterializationStatus,
  getStaleRunningToolMessageID,
  isSessionMaterializationStillNeeded,
  materializeSessionSnapshots,
} from "../materialization"
import { createMessageOrderState } from "../message-order"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 } } as Message
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } } as Message
}

function part(id: string, messageID: string, type = "text", text = id): Part {
  return { id, messageID, sessionID: "ses_1", type, text } as Part
}

describe("materializeSessionSnapshots", () => {
  test("marks an empty successful page as materialized", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [],
      { order: createMessageOrderState() },
    )

    expect(result.message.ses_1).toEqual([])
    expect(result.messagesChanged).toBe(true)
    expect(getSessionMaterializationStatus(result, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })

  test("materializes messages and parts together", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_1", "msg_1")] }],
      { order: createMessageOrderState() },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_1"])
    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result.messagesChanged).toBe(true)
    expect(result.partsChanged).toBe(true)
  })

  test("preserves unchanged references", () => {
    const existingMessage = message("msg_1")
    const existingPart = part("prt_1", "msg_1")
    const state = { message: { ses_1: [existingMessage] }, part: { msg_1: [existingPart] } }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: existingMessage, parts: [existingPart] }],
      { order: createMessageOrderState() },
    )

    expect(result.message).toBe(state.message)
    expect(result.part).toBe(state.part)
    expect(result.messagesChanged).toBe(false)
    expect(result.partsChanged).toBe(false)
  })

  test("skips non-rendered part types", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: message("msg_1"), parts: [part("prt_patch", "msg_1", "patch"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["patch"]), order: createMessageOrderState() },
    )

    expect(result.part.msg_1.map((item) => item.id)).toEqual(["prt_text"])
  })

  test("preserves newer live streaming text when a stale snapshot materializes", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const stalePart = part("prt_1", "msg_1", "text", "")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
      { order: createMessageOrderState() },
    )

    expect(result.part.msg_1[0]).toBe(livePart)
    expect((result.part.msg_1[0] as { text?: string })?.text).toBe("First chunk ")
  })

  test("preserves live streaming parts omitted by a stale snapshot", () => {
    const livePart = part("prt_1", "msg_1", "text", "First chunk ")
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [] }],
      { order: createMessageOrderState() },
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("does not preserve omitted optimistic user text parts beside server snapshot parts", () => {
    const optimisticPart = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "Hello" } as Part
    const serverPart = part("prt_server", "msg_1", "text", "Hello")
    const state = {
      message: { ses_1: [userMessage("msg_1")] },
      part: { msg_1: [optimisticPart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: userMessage("msg_1"), parts: [serverPart] }],
      { order: createMessageOrderState() },
    )

    expect(result.part.msg_1).toEqual([serverPart])
  })

  test("preserves state.time from existing part when snapshot drops it", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed", time: { start: 1000, end: 2000 } },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed" },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
      { order: createMessageOrderState() },
    )

    const mergedPart = result.part.msg_1[0] as { state?: { time?: { start?: number; end?: number } } }
    expect(mergedPart.state?.time?.start).toBe(1000)
    expect(mergedPart.state?.time?.end).toBe(2000)
  })

  test("does not regress a locally interrupted tool (error + end) when a stale running snapshot arrives", () => {
    // The #2577 mark writes status "error" + end time; a later stale refresh
    // that still reports the part as running must not undo it.
    const interruptedTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "error", error: "Interrupted", time: { start: 1000, end: 5000 } },
    } as unknown as Part
    const staleRunningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "running", time: { start: 1000 } },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [interruptedTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [staleRunningTool] }],
    )

    expect(result.part.msg_1[0]).toBe(interruptedTool)
    expect(result.part.msg_1[0]).not.toBe(staleRunningTool)
    expect((result.part.msg_1[0] as { state: { status: string } }).state.status).toBe("error")
  })

  test("does not regress a completed tool when a stale running snapshot arrives", () => {
    const completedTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed", output: "done", time: { start: 1000, end: 2000 } },
    } as unknown as Part
    const staleRunningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "running", time: { start: 1000 } },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [completedTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [staleRunningTool] }],
    )

    expect(result.part).toBe(state.part)
    expect(result.part.msg_1[0]).toBe(completedTool)
    expect(getStaleRunningToolMessageID(result, "ses_1")).toBe(undefined)
  })

  test("preserves state.attachments from existing part when completed snapshot lacks them", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "completed",
        output: "done",
        time: { start: 100, end: 200 },
        attachments: [{ id: "att-1", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed", output: "done", time: { start: 100, end: 200 } },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown> } }
    expect(mergedPart.state?.attachments).toHaveLength(1)
    expect((mergedPart.state?.attachments?.[0] as { id?: string })?.id).toBe("att-1")
  })

  test("preserves state.attachments during streaming merge when snapshot has no end time", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "running",
        time: { start: 100 },
        attachments: [{ id: "att-1", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "running", time: { start: 100 } },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown> } }
    expect(mergedPart.state?.attachments).toHaveLength(1)
    expect((mergedPart.state?.attachments?.[0] as { id?: string })?.id).toBe("att-1")
  })

  test("preserves both state.attachments and state.time.start during streaming merge when snapshot lacks both", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "running",
        time: { start: 100 },
        attachments: [{ id: "att-1", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "running" },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown>; time?: { start?: number; end?: number } } }
    expect(mergedPart.state?.attachments).toHaveLength(1)
    expect((mergedPart.state?.attachments?.[0] as { id?: string })?.id).toBe("att-1")
    expect(mergedPart.state?.time?.start).toBe(100)
  })

  test("does not merge existing state.attachments when snapshot has its own", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "completed",
        output: "done",
        time: { start: 100, end: 200 },
        attachments: [{ id: "att-old", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "completed",
        output: "done",
        time: { start: 100, end: 200 },
        attachments: [{ id: "att-new", type: "file", mime: "image/jpeg", url: "data:image/jpeg,..." }],
      },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown> } }
    expect(mergedPart.state?.attachments).toHaveLength(1)
    expect((mergedPart.state?.attachments?.[0] as { id?: string })?.id).toBe("att-new")
  })

  test("treats empty state.attachments in completed snapshot as authoritative", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "completed",
        output: "done",
        time: { start: 100, end: 200 },
        attachments: [{ id: "att-old", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "completed",
        output: "done",
        time: { start: 100, end: 200 },
        attachments: [],
      },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown> } }
    expect(mergedPart.state?.attachments).toEqual([])
  })

  test("treats empty state.attachments in streaming snapshot as authoritative", () => {
    const livePart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: {
        status: "running",
        time: { start: 100 },
        attachments: [{ id: "att-old", type: "file", mime: "image/png", url: "data:image/png,..." }],
      },
    } as unknown as Part
    const snapshotPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "running", time: { start: 100 }, attachments: [] },
    } as unknown as Part
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [livePart] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [snapshotPart] }],
    )

    const mergedPart = result.part.msg_1[0] as { state?: { attachments?: Array<unknown> } }
    expect(mergedPart.state?.attachments).toEqual([])
  })

  test("preserves a final tool state over a stale running snapshot", () => {
    const finalPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 } },
    } as Part
    const stalePart = {
      ...finalPart,
      state: { status: "running", input: {}, time: { start: 1 } },
    } as Part

    const result = materializeSessionSnapshots(
      { message: { ses_1: [message("msg_1")] }, part: { msg_1: [finalPart] } },
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
      { order: createMessageOrderState() },
    )

    expect(result.part.msg_1[0]).toBe(finalPart)
  })

  test("complete mode removes messages and parts omitted by the authoritative snapshot", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.message.set("msg_kept", 2)
    order.part.set("prt_old", 1)
    order.part.set("prt_kept", 2)
    const kept = message("msg_kept")
    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old"), kept] },
        part: {
          msg_old: [part("prt_old", "msg_old")],
          msg_kept: [part("prt_kept", "msg_kept")],
        },
      },
      "ses_1",
      [{ info: kept, parts: [part("prt_kept", "msg_kept")] }],
      { order, mode: "complete" },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_kept"])
    expect(result.part.msg_old).toBe(undefined)
  })

  test("recent mode removes stale recent messages but preserves older history", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.message.set("msg_stale", 2)
    order.message.set("msg_latest", 3)
    const latest = message("msg_latest")
    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old"), message("msg_stale"), latest] },
        part: { msg_stale: [part("prt_stale", "msg_stale")] },
      },
      "ses_1",
      [{ info: latest, parts: [] }],
      { order, mode: "recent", recentBoundary: 3 },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_old", "msg_stale", "msg_latest"])

    order.message.set("msg_boundary", 2)
    const boundary = message("msg_boundary")
    const refreshed = materializeSessionSnapshots(
      {
        message: result.message,
        part: result.part,
      },
      "ses_1",
      [{ info: boundary, parts: [] }, { info: latest, parts: [] }],
      { order, mode: "recent", recentBoundary: 2 },
    )
    expect(refreshed.message.ses_1.map((item) => item.id)).toEqual(["msg_old", "msg_boundary", "msg_latest"])
    expect(refreshed.part.msg_stale).toBe(undefined)
    expect(order.message.has("msg_stale")).toBe(false)
    expect(order.messageRevision.has("msg_stale")).toBe(false)
    expect(order.messageSession.has("msg_stale")).toBe(false)
  })

  test("recent boundary ignores optimistic messages without a sequence", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.message.set("msg_boundary", 2)
    order.message.set("msg_stale", 3)
    order.message.set("msg_latest", 4)
    const optimistic = userMessage("msg_optimistic")

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old"), message("msg_boundary"), message("msg_stale"), message("msg_latest"), optimistic] },
        part: {},
      },
      "ses_1",
      [
        { info: message("msg_boundary"), parts: [] },
        { info: message("msg_latest"), parts: [] },
        { info: optimistic, parts: [] },
      ],
      { order, mode: "recent", recentBoundary: 2 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_boundary", "msg_latest", "msg_optimistic"])
  })

  test("recent boundary is not lowered by a concurrently retained message", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.message.set("msg_stale", 5)
    order.message.set("msg_boundary", 6)
    order.message.set("msg_latest", 7)
    order.message.set("msg_concurrent", 2)

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old"), message("msg_concurrent"), message("msg_stale"), message("msg_boundary"), message("msg_latest")] },
        part: {},
      },
      "ses_1",
      [
        { info: message("msg_concurrent"), parts: [] },
        { info: message("msg_boundary"), parts: [] },
        { info: message("msg_latest"), parts: [] },
      ],
      { order, mode: "recent", recentBoundary: 6 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_concurrent", "msg_stale", "msg_boundary", "msg_latest"])
  })

  test("prepend does not overwrite parts for an overlapping cached message", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.message.set("msg_overlap", 2)
    order.part.set("prt_old", 1)
    order.part.set("prt_live", 2)
    const livePart = part("prt_live", "msg_overlap", "text", "live")

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_overlap")] },
        part: { msg_overlap: [livePart] },
      },
      "ses_1",
      [
        { info: message("msg_old"), parts: [part("prt_old", "msg_old")] },
        { info: message("msg_overlap"), parts: [part("prt_live", "msg_overlap", "text", "stale")] },
      ],
      { order, mode: "prepend" },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_overlap"])
    expect(result.part.msg_overlap).toEqual([livePart])
  })

  test("complete empty snapshot clears cached messages and parts", () => {
    const order = createMessageOrderState()
    order.message.set("msg_old", 1)
    order.part.set("prt_old", 1)

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old")] },
        part: { msg_old: [part("prt_old", "msg_old")] },
      },
      "ses_1",
      [],
      { order, mode: "complete" },
    )

    expect(result.messages).toEqual([])
    expect(result.part.msg_old).toBe(undefined)
  })
})

describe("getSessionMaterializationStatus", () => {
  test("requires assistant parts for renderable cached state", () => {
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: false,
      missingPartMessageIDs: ["msg_1"],
    })
  })

  test("treats user-only cached state as renderable", () => {
    const state = {
      message: { ses_1: [{ ...message("msg_1"), role: "user" } as Message] },
      part: {},
    }

    expect(getSessionMaterializationStatus(state, "ses_1")).toEqual({
      hasMessages: true,
      renderable: true,
      missingPartMessageIDs: [],
    })
  })
})

describe("isSessionMaterializationStillNeeded", () => {
  test("skips empty-assistant recovery after a part bucket arrives", () => {
    const state = { message: { ses_1: [message("msg_1")] }, part: { msg_1: [part("prt_1", "msg_1")] } }

    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "empty-assistant-message",
      messageID: "msg_1",
    })).toBe(false)
  })

  test("treats an explicit empty part bucket as authoritative", () => {
    const state = { message: { ses_1: [message("msg_1")] }, part: { msg_1: [] } }

    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "empty-assistant-message",
      messageID: "msg_1",
    })).toBe(false)
  })

  test("skips missing-message and missing-part recovery after ordered events repair state", () => {
    const state = { message: { ses_1: [message("msg_1")] }, part: { msg_1: [part("prt_1", "msg_1")] } }

    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "missing-owning-message",
      messageID: "msg_1",
    })).toBe(false)
    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "missing-delta-part",
      messageID: "msg_1",
      partID: "prt_1",
    })).toBe(false)
  })

  test("keeps recovery active while the requested entity is still missing", () => {
    const state = { message: { ses_1: [message("msg_1")] }, part: {} }

    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "orphan-delta",
      messageID: "msg_1",
      partID: "prt_1",
    })).toBe(true)
  })

  test("recovers a settled session whose trailing assistant still has a running tool", () => {
    const runningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "read",
      state: { status: "running" },
    } as Part
    const state = { message: { ses_1: [message("msg_1")] }, part: { msg_1: [runningTool] } }

    expect(getStaleRunningToolMessageID(state, "ses_1")).toBe("msg_1")
    expect(isSessionMaterializationStillNeeded(state, "ses_1", {
      reason: "settled-running-tool",
      messageID: "msg_1",
    })).toBe(true)

    const completedState = {
      ...state,
      part: { msg_1: [{ ...runningTool, state: { status: "completed" } } as Part] },
    }
    expect(getStaleRunningToolMessageID(completedState, "ses_1")).toBe(undefined)
    expect(isSessionMaterializationStillNeeded(completedState, "ses_1", {
      reason: "settled-running-tool",
      messageID: "msg_1",
    })).toBe(false)
  })

  test("does not recover an older running tool after a newer user turn", () => {
    const state = {
      message: { ses_1: [message("msg_1"), userMessage("msg_2")] },
      part: {
        msg_1: [{
          id: "prt_1",
          messageID: "msg_1",
          sessionID: "ses_1",
          type: "tool",
          tool: "read",
          state: { status: "running" },
        } as Part],
      },
    }

    expect(getStaleRunningToolMessageID(state, "ses_1")).toBe(undefined)
  })
})
