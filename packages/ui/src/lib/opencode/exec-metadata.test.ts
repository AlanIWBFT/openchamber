import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "@opencode/client"
import { applyDirectoryEvent } from "@/sync/event-reducer"
import { materializeSessionSnapshots } from "@/sync/materialization"
import { INITIAL_STATE, type State } from "@/sync/types"
import { translateWireEvent } from "./events"
import type { ToolPart } from "./model"

const state = (part: ToolPart): State => ({
  ...INITIAL_STATE,
  message: { ses_1: [{ id: "msg_a", sessionID: "ses_1", role: "assistant", time: { created: 1 }, agent: "build", providerID: "p", modelID: "m" }] },
  part: { msg_a: [part] },
  session_status: { ses_1: { type: "idle" } },
})
const base = { id: "evt_exec", created: 1000, location: { directory: "/repo" } }
const durable = { aggregateID: "ses_1", seq: 2, version: 1 as const }
const metadata = { command: "test", output: "latest", interactions: [], processRunning: false, truncated: false, execDisplay: "root" as const }
const part = (tool = "exec_command"): ToolPart => ({
  id: "call_1", callID: "call_1", type: "tool", tool, sessionID: "ses_1", messageID: "msg_a",
  state: { status: "completed", input: {}, output: "model result", time: { start: 1, end: 2 }, metadata: { execRevision: 1, processRunning: true } },
})
const deliver = (draft: State, event: OpenCodeEvent) => translateWireEvent(event).map((value) => applyDirectoryEvent(draft, value))

describe("unified exec wire events", () => {
  test("a preview updates a completed call without reopening its model turn, and stale captures are no-ops", () => {
    const draft = state(part())
    const messages = draft.message
    const statuses = draft.session_status
    const data = { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", revision: 3, metadata }
    expect(deliver(draft, { ...base, type: "session.exec.updated", data })).toEqual([true])
    expect(draft.part.msg_a[0]).toMatchObject({ state: { status: "completed", output: "model result", metadata: { execRevision: 3, output: "latest", processRunning: false } } })
    const settled = draft.part.msg_a[0]
    expect(deliver(draft, { ...base, type: "session.exec.captured", durable, data: { ...data, revision: 2 } })).toEqual([false])
    expect(draft.part.msg_a[0]).toBe(settled)
    expect(draft.message).toBe(messages)
    expect(draft.session_status).toBe(statuses)
  })

  test("Script snapshots preserve newer child output and exec updates retain unrelated child identities", () => {
    const root = part("execute")
    const child = { id: "child_1", name: "exec_command", tool: "functions.exec_command", status: "completed", metadata: { execRevision: 1, output: "old" } }
    let unrelatedReads = 0
    const sibling = { id: "child_2", name: "read", tool: "functions.read", status: "completed", metadata: {
      get details() { unrelatedReads++; return { files: ["unrelated"] } },
    } }
    if (root.state.status !== "completed") throw new Error("fixture must be completed")
    root.state.metadata = { codeModeRevision: 1, toolCalls: [child, sibling] }
    const draft = state(root)
    deliver(draft, { ...base, type: "session.exec.updated", data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", childID: "child_1", revision: 5, metadata } })
    expect(unrelatedReads).toBe(0)
    const updated = draft.part.msg_a[0]
    if (updated.type !== "tool" || updated.state.status !== "completed") throw new Error("preview changed the call lifecycle")
    const calls = updated.state.metadata?.toolCalls
    if (!Array.isArray(calls)) throw new Error("missing children")
    expect(calls[1]).toBe(sibling)
    expect(calls[0]).toMatchObject({ metadata: { execRevision: 5, output: "latest" } })
    deliver(draft, { ...base, type: "session.script.captured", durable, data: {
      sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", revision: 2,
      toolCalls: [{ ...child, status: "completed" }, { ...sibling, status: "completed" }],
    } })
    expect(draft.part.msg_a[0]).toMatchObject({ state: { status: "completed", output: "model result", metadata: {
      codeModeRevision: 2, toolCalls: [{ metadata: { execRevision: 5, output: "latest" } }, sibling],
    } } })
  })

  test("tool settlement keeps a preview that arrived after the tool result was produced", () => {
    const root = part()
    root.state = { status: "running", input: {}, time: { start: 1 }, metadata: { execRevision: 4, output: "newer", processRunning: false } }
    const draft = state(root)
    applyDirectoryEvent(draft, { type: "message.tool.transition", properties: { sessionID: "ses_1", messageID: "msg_a", partID: "call_1", transition: {
      kind: "success", output: "model result", executed: true, end: 2, metadata: { output: "older", processRunning: true },
    } } })
    expect(draft.part.msg_a[0]).toMatchObject({ state: { status: "completed", output: "model result", metadata: { execRevision: 4, output: "newer", processRunning: false } } })
  })

  test("a history response started before the latest preview cannot restore old output", () => {
    const stale = part()
    const draft = state(part())
    deliver(draft, { ...base, type: "session.exec.updated", data: { sessionID: "ses_1", assistantMessageID: "msg_a", id: "call_1", revision: 5, metadata } })
    const result = materializeSessionSnapshots(draft, "ses_1", [{ info: draft.message.ses_1[0], parts: [stale] }])
    expect(result.part.msg_a[0]).toMatchObject({ state: { status: "completed", metadata: { execRevision: 5, output: "latest", processRunning: false } } })
  })
})
