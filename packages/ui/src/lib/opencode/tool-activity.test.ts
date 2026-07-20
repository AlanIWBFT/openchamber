import { expect, test } from "bun:test"
import type { AssistantMessage, ToolPart } from "./model"
import { activityToolCalls } from "./tool-activity"
import { summarizeLiveActivity } from "../../components/chat/lib/turns/liveActivitySummary"

test("Script activity counts commands, files and categories without reading output payloads", () => {
  let payloadReads = 0
  const info: AssistantMessage = { id: "m1", sessionID: "s1", role: "assistant", agent: "build", providerID: "test", modelID: "test", time: { created: 1 } }
  const script: ToolPart = { id: "script", callID: "script-call", messageID: info.id, sessionID: info.sessionID, type: "tool", tool: "execute", state: {
    status: "completed", input: { get code() { payloadReads++; return "large script" } }, output: "", time: { start: 1, end: 2 },
    metadata: { toolCalls: [
      { id: "command", name: "exec_command", tool: "functions.exec_command", status: "completed", metadata: {
        processRunning: true, get output() { payloadReads++; return "large output" },
      }, get content() { payloadReads++; return [] } },
      { id: "poll", name: "poll_exec", tool: "functions.poll_exec", status: "completed" },
      { id: "edit", name: "patch", tool: "functions.patch", status: "completed", metadata: { files: [{ file: "/repo/a.ts", additions: 2, deletions: 1 }] } },
      { id: "read", name: "read", tool: "functions.read", status: "completed" },
      { id: "web", name: "websearch", tool: "functions.websearch", status: "completed" },
      { id: "agent", name: "subagent", tool: "functions.subagent", status: "completed", metadata: { sessionID: "child" } },
    ] },
  } }
  const summary = summarizeLiveActivity([{ info, parts: [script] }])
  expect(summary).toMatchObject({ commands: 1, runningCommands: 1, files: 1, additions: 2, deletions: 1, explored: true, researched: true, subagents: 1 })
  expect(payloadReads).toBe(0)
  const second = { ...script, id: "second-script" }
  const firstChild = Array.from(activityToolCalls([script]))[1]
  const secondChild = Array.from(activityToolCalls([second]))[1]
  expect(firstChild.id).not.toBe(secondChild.id)
})
