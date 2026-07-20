import { z } from "zod"
import type { JsonValue, Metadata, ToolPart } from "./model"
import {
  executeToolCalls, isExecFollowUpTool, isUnifiedExecTool,
  readUnifiedExecMetadata, redactExecFollowUpInput, shouldHideExecFollowUpState, type ExecuteToolCall,
} from "./tools"

export type ScriptToolEntry = { kind: "part"; part: ToolPart } | { kind: "summary"; call: ExecuteToolCall }

const inputSchema = z.record(z.string(), z.json())
const callSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  tool: z.string(),
  status: z.string().optional(),
  input: z.json().optional(),
  metadata: inputSchema.optional(),
  error: z.string().optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})
const childID = (parent: string, child: string) => `${parent}:child:${child}`

/** Ordinary calls use the upstream summary; only persistent execs get live command cards. */
export function createScriptToolProjection(owner: Pick<ToolPart, "id" | "sessionID" | "messageID">) {
  let previous = new Map<JsonValue, ScriptToolEntry | null>()
  return (metadata: Metadata | undefined): ScriptToolEntry[] => {
    const values = metadata?.toolCalls
    const next = new Map<JsonValue, ScriptToolEntry | null>()
    const entries: ScriptToolEntry[] = []
    if (Array.isArray(values)) for (const value of values) {
      const entry = previous.has(value) ? previous.get(value) ?? null : project(value)
      next.set(value, entry)
      if (entry) entries.push(entry)
    }
    previous = next
    return entries
  }

  function project(value: JsonValue): ScriptToolEntry | null {
    const parsed = callSchema.safeParse(value)
    if (!parsed.success) return null
    const call = parsed.data
    const tool = call.name ?? call.tool
    if (!isUnifiedExecTool(tool)) {
      const summary = executeToolCalls({ toolCalls: [value] })[0]
      return summary ? { kind: "summary", call: summary } : null
    }
    const exec = readUnifiedExecMetadata(call.metadata)
    if (shouldHideExecFollowUpState(tool, call.status, exec)) return null
    const input = inputSchema.safeParse(call.input)
    const safeInput = redactExecFollowUpInput(tool, input.success ? input.data : undefined)
    if (!call.id || !call.time || (call.status !== "running" && call.status !== "completed" && call.status !== "error")) {
      const compact: Metadata = { tool: call.tool }
      if (call.status !== undefined) compact.status = call.status
      if (safeInput !== undefined) compact.input = safeInput
      else if (call.input !== undefined && !isExecFollowUpTool(tool)) compact.input = call.input
      const summary = executeToolCalls({ toolCalls: [compact] })[0]
      return summary ? { kind: "summary", call: summary } : null
    }
    const callID = childID(owner.id, call.id)
    const common = { input: safeInput ?? {}, metadata: call.metadata }
    const output = exec.output ?? ""
    const end = call.time.end ?? call.time.start
    const part: ToolPart = {
      id: callID, callID, sessionID: owner.sessionID, messageID: owner.messageID, type: "tool", tool,
      state: call.status === "running"
        ? { ...common, status: "running", time: { start: call.time.start } }
        : call.status === "error"
          ? { ...common, status: "error", error: call.error ?? exec.execError ?? "", output, time: { start: call.time.start, end } }
          : { ...common, status: "completed", output, time: { start: call.time.start, end } },
    }
    return { kind: "part", part }
  }
}
