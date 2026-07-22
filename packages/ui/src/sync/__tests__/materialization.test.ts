import { describe, expect, test } from "bun:test"
import type { CompactionMessage, Message, Part, PartType, StoredMessage, ToolPart } from "@/lib/opencode/model"
import {
  getSessionMaterializationStatus,
  getStaleRunningToolMessageID,
  isSessionMaterializationStillNeeded,
  materializeSessionSnapshots,
} from "../materialization"

function message(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "assistant", time: { created: 1 }, agent: "agent", providerID: "provider", modelID: "model" }
}

function userMessage(id: string, sessionID = "ses_1"): Message {
  return { id, sessionID, role: "user", time: { created: 1 } }
}

const storedMessage = (id: string, seq: number): StoredMessage => ({ ...message(id), seq })

function completedAssistantMessage(id: string, sessionID = "ses_1"): Message {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 1, completed: 4000 },
    modelID: "model",
    providerID: "provider",
    agent: "agent",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  }
}

function part(id: string, messageID: string, type: PartType = "text", text = id): Part {
  if (type === "reasoning") return { id, messageID, sessionID: "ses_1", type, text, time: { start: 1 } }
  if (type === "file") return { id, messageID, sessionID: "ses_1", type, mime: "text/plain", url: text }
  if (type === "agent") return { id, messageID, sessionID: "ses_1", type, name: text }
  if (type === "tool") {
    return { id, messageID, sessionID: "ses_1", type, callID: `call-${id}`, tool: text, state: { status: "pending", input: {}, raw: "" } }
  }
  return { id, messageID, sessionID: "ses_1", type: "text", text }
}

describe("materializeSessionSnapshots", () => {
  test("a running database snapshot preserves live compaction text, but completion replaces it", () => {
    const live: CompactionMessage = {
      id: "compaction", sessionID: "ses_1", role: "compaction", seq: 3,
      time: { created: 1 }, status: "running", reason: "manual", summary: "live progress",
    }
    const state = { message: { ses_1: [live] }, part: {} }
    const running = materializeSessionSnapshots(state, "ses_1", [{ info: { ...live, summary: "live" }, parts: [] }])
    expect(running.messages[0]).toEqual(live)
    const completed: CompactionMessage = { ...live, status: "completed", summary: "final" }
    expect(materializeSessionSnapshots(state, "ses_1", [{ info: completed, parts: [] }]).messages[0]).toEqual(completed)
  })
  test("removes a completed snapshot's missing messages without mutating the previous parts map", () => {
    const removed = part("prt_removed", "msg_removed")
    const unrelated = part("prt_other", "msg_other")
    const state = {
      message: { ses_1: [message("msg_removed")], ses_2: [message("msg_other", "ses_2")] },
      part: Object.freeze({ msg_removed: [removed], msg_other: [unrelated] }),
    }
    const result = materializeSessionSnapshots(state, "ses_1", [], { mode: "complete" })
    expect(result.part).not.toBe(state.part)
    expect(result.part.msg_removed).toBeUndefined()
    expect(state.part.msg_removed).toEqual([removed])
    expect(result.part.msg_other).toBe(state.part.msg_other)
    expect(result.message.ses_2).toBe(state.message.ses_2)
    expect(result.partsChanged).toBe(true)
  })

  test("finalizes an active tool under a completed assistant message", () => {
    const completedMessage = completedAssistantMessage("msg_1")
    const staleRunningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: { status: "running", input: { command: "ls" }, time: { start: 1000 } },
      callID: "call-prt_1",
    } satisfies ToolPart

    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [{ info: completedMessage, parts: [staleRunningTool] }],
    )

    const reconciledPart = result.part.msg_1[0]
    if (!reconciledPart || reconciledPart.type !== "tool") throw new Error("Expected tool part")
    if (reconciledPart.state.status !== "error") throw new Error("Expected interrupted tool part")
    expect(reconciledPart.state.error).toBe("Interrupted")
    expect(reconciledPart.state.time).toEqual({ start: 1000, end: 4000 })
    expect(getStaleRunningToolMessageID(result, "ses_1")).toBe(undefined)
  })

  test("preserves a terminal tool already observed when a completed snapshot is stale", () => {
    const completedMessage = completedAssistantMessage("msg_1")
    const terminalTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls" },
        output: "done",
        metadata: {},
        time: { start: 1000, end: 2000 },
      },
      callID: "call-prt_1",
    } satisfies ToolPart
    const staleRunningTool = {
      ...terminalTool,
      state: { status: "running", input: {}, time: { start: 1000 } },
    } satisfies ToolPart
    const state = {
      message: { ses_1: [completedMessage] },
      part: { msg_1: [terminalTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: completedMessage, parts: [staleRunningTool] }],
    )

    expect(result.part).toBe(state.part)
    expect(result.part.msg_1[0]).toBe(terminalTool)
  })

  test("marks an empty successful page as materialized", () => {
    const result = materializeSessionSnapshots(
      { message: {}, part: {} },
      "ses_1",
      [],
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
      [{ info: message("msg_1"), parts: [part("prt_agent", "msg_1", "agent"), part("prt_text", "msg_1")] }],
      { skipPartTypes: new Set(["agent"]) },
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
    )

    expect(result.part.msg_1[0]).toBe(livePart)
  })

  test("preserves a locally aborted assistant message when a stale unfinished snapshot arrives", () => {
    const unfinishedMessage = message("msg_1")
    if (unfinishedMessage.role !== "assistant") throw new Error("Expected assistant fixture")
    const abortedMessage: Message = {
      ...unfinishedMessage,
      time: { created: 1, completed: 5000 },
      error: { type: "aborted", message: "aborted" },
    }
    const staleMessage = message("msg_1")
    const state = {
      message: { ses_1: [abortedMessage] },
      part: { msg_1: [] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: staleMessage, parts: [] }],
    )

    expect(result.message).toBe(state.message)
    expect(result.message.ses_1[0]).toBe(abortedMessage)
    expect(result.message.ses_1[0]).not.toBe(staleMessage)
  })

  test("replaces a locally aborted assistant message with the authoritative completed snapshot", () => {
    const unfinishedMessage = message("msg_1")
    if (unfinishedMessage.role !== "assistant") throw new Error("Expected assistant fixture")
    const abortedMessage: Message = {
      ...unfinishedMessage,
      time: { created: 1, completed: 5000 },
      error: { type: "aborted", message: "aborted" },
    }
    const completedMessage: Message = {
      ...unfinishedMessage,
      time: { created: 1, completed: 4000 },
    }
    const state = {
      message: { ses_1: [abortedMessage] },
      part: { msg_1: [] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: completedMessage, parts: [] }],
    )

    const reconciled = result.message.ses_1[0]
    expect(reconciled).toBe(completedMessage)
    expect(reconciled?.role).toBe("assistant")
    if (reconciled?.role !== "assistant") throw new Error("Expected assistant result")
    expect("error" in reconciled).toBe(false)
    expect(reconciled.time.completed).toBe(4000)
  })

  test("confirming seq does not reopen an interrupted message or its newly fetched pending tool", () => {
    const unfinished = message("msg_1")
    if (unfinished.role !== "assistant") throw new Error("Expected assistant fixture")
    const aborted: Message = { ...unfinished, time: { created: 1, completed: 5000 }, error: { type: "aborted", message: "aborted" } }
    const result = materializeSessionSnapshots(
      { message: { ses_1: [aborted] }, part: {} },
      "ses_1",
      [{ info: { ...unfinished, seq: 12 }, parts: [part("tool_1", "msg_1", "tool", "read")] }],
    )
    expect(result.messages[0]).toEqual({ ...aborted, seq: 12 })
    expect(result.part.msg_1[0]).toMatchObject({ state: { status: "error", error: "Interrupted", time: { end: 5000 } } })
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

  test("keeps a live running subagent call when a stale pending snapshot arrives", () => {
    const runningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call-1",
      tool: "subagent",
      state: { status: "running", input: {}, metadata: { sessionID: "ses_child" }, time: { start: 1000 } },
    } satisfies ToolPart
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [runningTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [{ ...runningTool, state: { status: "pending", input: {}, raw: "" } }] }],
    )

    expect(result.part.msg_1[0]).toBe(runningTool)
  })

  test("keeps live progress metadata when a stale running snapshot lacks it", () => {
    const runningTool = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call-1",
      tool: "subagent",
      state: { status: "running", input: {}, metadata: { sessionID: "ses_child" }, time: { start: 1000 } },
    } satisfies ToolPart
    const state = {
      message: { ses_1: [message("msg_1")] },
      part: { msg_1: [runningTool] },
    }

    const result = materializeSessionSnapshots(
      state,
      "ses_1",
      [{ info: message("msg_1"), parts: [{ ...runningTool, state: { status: "running", input: {}, time: { start: 1000 } } }] }],
    )

    const merged = result.part.msg_1[0]
    if (merged?.type !== "tool" || merged.state.status !== "running") throw new Error("Expected running tool part")
    expect(merged.state.metadata).toEqual({ sessionID: "ses_child" })
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
    const finalPart: ToolPart = {
      id: "prt_1",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call", tool: "read",
      state: { status: "completed", input: {}, output: "done", metadata: {}, time: { start: 1, end: 2 } },
    }
    const stalePart: ToolPart = {
      ...finalPart,
      state: { status: "running", input: {}, time: { start: 1 } },
    }

    const result = materializeSessionSnapshots(
      { message: { ses_1: [message("msg_1")] }, part: { msg_1: [finalPart] } },
      "ses_1",
      [{ info: message("msg_1"), parts: [stalePart] }],
    )

    expect(result.part.msg_1[0]).toBe(finalPart)
  })

  test("complete mode removes messages and parts omitted by the authoritative snapshot", () => {
    const kept = storedMessage("msg_kept", 2)
    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [storedMessage("msg_old", 1), kept] },
        part: {
          msg_old: [part("prt_old", "msg_old")],
          msg_kept: [part("prt_kept", "msg_kept")],
        },
      },
      "ses_1",
      [{ info: kept, parts: [part("prt_kept", "msg_kept")] }],
      { mode: "complete" },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_kept"])
    expect(result.part.msg_old).toBe(undefined)
  })

  test("recent mode removes stale recent messages but preserves older history", () => {
    const latest = storedMessage("msg_latest", 9)
    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [storedMessage("msg_old", 1), storedMessage("msg_stale", 4), latest] },
        part: { msg_stale: [part("prt_stale", "msg_stale")] },
      },
      "ses_1",
      [{ info: latest, parts: [] }],
      { mode: "recent", recentBoundary: 9 },
    )

    expect(result.message.ses_1.map((item) => item.id)).toEqual(["msg_old", "msg_stale", "msg_latest"])

    const boundary = storedMessage("msg_boundary", 3)
    const refreshed = materializeSessionSnapshots(
      {
        message: result.message,
        part: result.part,
      },
      "ses_1",
      [{ info: boundary, parts: [] }, { info: latest, parts: [] }],
      { mode: "recent", recentBoundary: 3 },
    )
    expect(refreshed.message.ses_1.map((item) => item.id)).toEqual(["msg_old", "msg_boundary", "msg_latest"])
    expect(refreshed.part.msg_stale).toBe(undefined)
  })

  test("recent boundary ignores optimistic messages without a sequence", () => {
    const optimistic = userMessage("msg_optimistic")

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [storedMessage("msg_old", 1), storedMessage("msg_boundary", 2), storedMessage("msg_stale", 3), storedMessage("msg_latest", 4), optimistic] },
        part: {},
      },
      "ses_1",
      [
        { info: storedMessage("msg_boundary", 2), parts: [] },
        { info: storedMessage("msg_latest", 4), parts: [] },
        { info: optimistic, parts: [] },
      ],
      { mode: "recent", recentBoundary: 2 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_boundary", "msg_latest", "msg_optimistic"])
  })

  test("recent boundary is not lowered by a concurrently retained message", () => {

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [storedMessage("msg_old", 1), storedMessage("msg_concurrent", 2), storedMessage("msg_stale", 5), storedMessage("msg_boundary", 6), storedMessage("msg_latest", 7)] },
        part: {},
      },
      "ses_1",
      [
        { info: storedMessage("msg_concurrent", 2), parts: [] },
        { info: storedMessage("msg_boundary", 6), parts: [] },
        { info: storedMessage("msg_latest", 7), parts: [] },
      ],
      { mode: "recent", recentBoundary: 6 },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_concurrent", "msg_stale", "msg_boundary", "msg_latest"])
  })

  test("prepend does not overwrite parts for an overlapping cached message", () => {
    const livePart = part("prt_live", "msg_overlap", "text", "live")

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [storedMessage("msg_overlap", 2)] },
        part: { msg_overlap: [livePart] },
      },
      "ses_1",
      [
        { info: storedMessage("msg_old", 1), parts: [part("prt_old", "msg_old")] },
        { info: storedMessage("msg_overlap", 2), parts: [part("prt_live", "msg_overlap", "text", "stale")] },
      ],
      { mode: "prepend" },
    )

    expect(result.messages.map((item) => item.id)).toEqual(["msg_old", "msg_overlap"])
    expect(result.part.msg_overlap).toEqual([livePart])
  })

  test("complete empty snapshot clears cached messages and parts", () => {

    const result = materializeSessionSnapshots(
      {
        message: { ses_1: [message("msg_old")] },
        part: { msg_old: [part("prt_old", "msg_old")] },
      },
      "ses_1",
      [],
      { mode: "complete" },
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
