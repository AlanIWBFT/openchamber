import { z } from "zod"
import type { JsonValue, Metadata, ToolPart } from "./model"
import { toolAttachments, toolOutputText } from "./projection"
import { executeToolCalls, isExecFollowUpTool, isExecuteTool, isFileChangeTool, isShellTool, readUnifiedExecMetadata, redactExecFollowUpInput, shouldHideExecFollowUpState, type ExecuteToolCall } from "./tools"

type ScriptToolEntry = { kind: "part"; part: ToolPart } | { kind: "summary"; call: ExecuteToolCall }

const inputSchema = z.record(z.string(), z.json())
const callSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  tool: z.string(),
  status: z.string().optional(),
  input: z.json().optional(),
  metadata: inputSchema.optional(),
  content: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("file"), uri: z.string(), mime: z.string(), name: z.string().optional() }),
  ])).optional(),
  error: z.string().optional(),
  time: z.object({ start: z.number(), end: z.number().optional() }).optional(),
})
const identitySchema = callSchema.pick({ id: true, name: true, tool: true, status: true, time: true })
const childID = (parent: string, child: string) => `${parent}:child:${child}`

/** Default-open settings also reveal the enclosing Script; manual overrides remain with the message owner. */
export function defaultExpandedScriptToolIDs(parent: ToolPart, options: { shell: boolean; edit: boolean }): string[] {
  if ((!options.shell && !options.edit) || !isExecuteTool(parent.tool) || parent.state.status === "pending") return []
  const values = parent.state.metadata?.toolCalls
  if (!Array.isArray(values)) return []
  const ids: string[] = []
  for (const value of values) {
    const parsed = identitySchema.safeParse(value)
    if (!parsed.success) continue
    const call = parsed.data
    if (!call.id || !call.time || (call.status !== "running" && call.status !== "completed" && call.status !== "error")) continue
    const tool = call.name ?? call.tool
    if (!(options.shell && isShellTool(tool)) && !(options.edit && isFileChangeTool(tool))) continue
    if (ids.length === 0) ids.push(parent.id)
    ids.push(childID(parent.id, call.id))
  }
  return ids
}

/** One expanded Script owns this projection. Only its current child records are retained. */
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
    const exec = readUnifiedExecMetadata(call.metadata)
    if (shouldHideExecFollowUpState(tool, call.status, exec)) return null
    const input = inputSchema.safeParse(call.input)
    const safeInput = redactExecFollowUpInput(tool, input.success ? input.data : undefined)
    if (!call.id || !call.time || (call.status !== "running" && call.status !== "completed" && call.status !== "error")) {
      const legacy: Metadata = { tool: call.tool }
      if (call.status !== undefined) legacy.status = call.status
      if (safeInput !== undefined) legacy.input = safeInput
      else if (call.input !== undefined && !isExecFollowUpTool(tool)) legacy.input = call.input
      const summary = executeToolCalls({ toolCalls: [legacy] })[0]
      return summary ? { kind: "summary", call: summary } : null
    }
    const callID = childID(owner.id, call.id)
    const common = { input: safeInput ?? {}, metadata: call.metadata }
    const output = toolOutputText(call.content)
    const end = call.time.end ?? call.time.start
    const part: ToolPart = {
      id: callID, callID, sessionID: owner.sessionID, messageID: owner.messageID, type: "tool", tool,
      state: call.status === "running"
        ? { ...common, status: "running", time: { start: call.time.start } }
        : call.status === "error"
          ? { ...common, status: "error", error: call.error ?? exec.execError ?? "", output, time: { start: call.time.start, end } }
          : { ...common, status: "completed", output, time: { start: call.time.start, end }, attachments: toolAttachments(call.content, { ...owner, callID }) },
    }
    return { kind: "part", part }
  }
}
