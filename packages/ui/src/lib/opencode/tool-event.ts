import type { OpenCodeEvent } from "@opencode/client"
import { compact, partIds, type FilePart, type JsonValue, type Metadata } from "./model"
import type { ExecPreview, ScriptPreview } from "./exec-metadata"
import type { SyncEvent } from "./events"

export type ToolTransition =
  | ({ kind: "exec"; live?: boolean } & ExecPreview)
  | ({ kind: "script" } & ScriptPreview)
  | { kind: "input"; raw: string }
  | { kind: "called"; input: Record<string, JsonValue>; executed: boolean; start: number }
  | { kind: "progress"; metadata: Metadata }
  | { kind: "success"; output: string; attachments?: FilePart[]; metadata?: Metadata; executed: boolean; end: number }
  | { kind: "failed"; error: string; errorType?: string; output?: string; metadata?: Metadata; executed: boolean; end: number }

export const toolTransition = (sessionID: string, messageID: string, callID: string, transition: ToolTransition): SyncEvent => ({
  type: "message.tool.transition",
  properties: { sessionID, messageID, partID: partIds.tool(callID), transition },
})

export function execEvent(event: Extract<OpenCodeEvent, {type: "session.exec.updated" | "session.exec.captured" | "session.script.captured"}>): SyncEvent {
  if (event.type !== "session.script.captured") {
    const { sessionID, assistantMessageID, id, childID, revision, metadata } = event.data
    return toolTransition(sessionID, assistantMessageID, id, compact({
      kind: "exec", live: event.type === "session.exec.updated", revision, childID, metadata: compact({ ...metadata, interactions: metadata.interactions.map((item) => ({ ...item })) }),
    }))
  }
  const { sessionID, assistantMessageID, id, revision, toolCalls } = event.data
  return toolTransition(sessionID, assistantMessageID, id, {
    kind: "script", revision,
    toolCalls: toolCalls.map((call) => {
      const record: Metadata = { tool: call.tool, status: call.status }
      for (const key of ["id", "name", "input", "metadata", "error"] as const) {
        const value = call[key]
        if (value !== undefined) record[key] = value
      }
      if (call.time) record.time = call.time.end === undefined ? { start: call.time.start } : { start: call.time.start, end: call.time.end }
      return record
    }),
  })
}
