import { describe, expect, test } from "bun:test"
import type { Metadata } from "./model"
import { createScriptToolProjection } from "./script"

const owner = { id: "script_1", sessionID: "ses_1", messageID: "msg_1" }
const child = (tool: string, overrides: Metadata = {}): Metadata => ({
  id: `${tool}_1`, name: tool, tool: `functions.${tool}`, status: "completed", input: {}, time: { start: 10, end: 20 }, ...overrides,
})

describe("Script child presentation", () => {
  test("ordinary calls stay compact even when historical records contain full results", () => {
    const entries = createScriptToolProjection(owner)({ toolCalls: [
      child("read", { content: [{ type: "text", text: "old full result" }] }),
      { tool: "openchamber_memory", status: "error", input: { action: "memory.save", parameters: { title: "note" } } },
      child("exec_command"),
    ] })
    expect(entries.map((entry) => entry.kind)).toEqual(["summary", "summary", "part"])
    expect(entries[1]).toMatchObject({ call: { tool: "openchamber_memory", action: "memory.save", status: "error" } })
    expect(JSON.stringify(entries)).not.toContain("old full result")
  })

  test("renders exec output from its snapshot without adding independent transcript records", () => {
    const entries = createScriptToolProjection(owner)({ toolCalls: [child("exec_command", {
      input: { cmd: "echo test" }, metadata: { processRunning: true, execID: 7, output: "result" },
    })] })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "part", part: {
      id: "script_1:child:exec_command_1", sessionID: "ses_1", messageID: "msg_1", tool: "exec_command",
      state: { status: "completed", input: { cmd: "echo test" }, output: "result", metadata: { processRunning: true, execID: 7 } },
    } })
  })

  test("hides successful controls and preserves failures without their stdin payload", () => {
    const failed = child("write_stdin", { status: "error", error: "stdin closed", input: { exec_id: 7, chars: "secret" } })
    const entries = createScriptToolProjection(owner)({ toolCalls: [
      child("poll_exec"), child("write_stdin", { input: { chars: "secret" } }), child("terminate_exec"), failed,
      child("poll_exec", { id: "failed_poll", metadata: { execError: "not found" } }),
    ] })
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: "part", part: { state: { status: "error", error: "stdin closed", input: { exec_id: 7 } } } })
    expect(JSON.stringify(entries)).not.toContain("secret")
    expect(failed.input).toEqual({ exec_id: 7, chars: "secret" })
  })

  test("keeps compact historical calls without inventing a start time", () => {
    expect(createScriptToolProjection(owner)({ toolCalls: [{ tool: "mcp.lookup", input: { query: "history" }, status: "completed" }] }))
      .toEqual([{ kind: "summary", call: { tool: "mcp.lookup", status: "completed", input: '{"query":"history"}' } }])
  })

  test("one changed child reparses only that child and retains the other 63 cards", () => {
    let reads = 0
    const make = (index: number): Metadata => ({
      ...child("exec_command", { id: `exec_${index}` }),
      get input() { reads++; return { path: `file_${index}` } },
    })
    const calls = Array.from({ length: 64 }, (_, index) => make(index))
    const project = createScriptToolProjection(owner)
    const first = project({ toolCalls: calls })
    reads = 0
    const next = project({ toolCalls: [make(0), ...calls.slice(1)] })
    expect(reads).toBe(1)
    expect(next[0]).not.toBe(first[0])
    for (let index = 1; index < 64; index++) expect(next[index]).toBe(first[index])
    project(undefined)
    expect(project({ toolCalls: calls })[1]).not.toBe(first[1])
    const other = createScriptToolProjection({ ...owner, id: "script_2" })({ toolCalls: calls })
    expect(other[0]).toMatchObject({ kind: "part", part: { id: "script_2:child:exec_0" } })
  })
})
