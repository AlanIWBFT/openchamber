import { describe, expect, test } from "bun:test"
import type { Metadata } from "./model"
import { createScriptToolProjection, groupScriptTools } from "./script"

const owner = { id: "script_1", sessionID: "ses_1", messageID: "msg_1" }
const child = (tool: string, overrides: Metadata = {}): Metadata => ({
  id: `${tool}_1`, name: tool, tool: `functions.${tool}`, status: "completed", input: {}, time: { start: 10, end: 20 }, ...overrides,
})

describe("Script child presentation", () => {
  test("groups adjacent built-in exploration inside its owner without copying child cards", () => {
    const entries = createScriptToolProjection(owner)({ toolCalls: [
      child("read"), child("grep"), child("exec_command"), child("read", { id: "read_2" }), child("plugin.read"),
    ] })
    const groups = groupScriptTools(owner.id, entries)
    expect(groups.map((group) => group.kind)).toEqual(["exploration", "part", "exploration", "part"])
    const first = groups[0]
    if (first.kind !== "exploration") throw new Error("Expected an exploration group")
    expect(first.counts).toEqual({ search: 1, read: 1 })
    expect(first.entries[0]).toBe(entries[0])
    expect(first.entries[1]).toBe(entries[1])
    expect(groupScriptTools(owner.id, entries.slice(0, 2))[0]).toMatchObject({ id: first.id })
    const other = groupScriptTools("another_script", entries)[0]
    if (other.kind !== "exploration") throw new Error("Expected an exploration group")
    expect(other.id).not.toBe(first.id)
  })

  test("renders full results and attachments without adding independent transcript records", () => {
    const entries = createScriptToolProjection(owner)({ toolCalls: [child("exec_command", {
      input: { cmd: "echo test" }, metadata: { processRunning: true, execID: 7 },
      content: [{ type: "text", text: "result" }, { type: "file", uri: "file:///repo/result.png", mime: "image/png", name: "result.png" }],
    })] })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: "part", part: {
      id: "script_1:child:exec_command_1", sessionID: "ses_1", messageID: "msg_1", tool: "exec_command",
      state: { status: "completed", input: { cmd: "echo test" }, output: "result", metadata: { processRunning: true, execID: 7 },
        attachments: [{ url: "file:///repo/result.png", mime: "image/png", filename: "result.png" }] },
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
      ...child("read", { id: `read_${index}` }),
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
    expect(other[0]).toMatchObject({ kind: "part", part: { id: "script_2:child:read_0" } })
  })
})
