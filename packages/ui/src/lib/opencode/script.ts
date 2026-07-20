import { z } from "zod"
import type { JsonValue, Metadata, ToolPart } from "./model"
import { toolAttachments, toolOutputText } from "./projection"
import {
  executeToolCalls, isExecCommandTool, isExecFollowUpTool, isExecuteTool, isExplorationGroupTool, isExplorationPartDisplayReady,
  isFileChangeTool, isShellTool, normalizeToolName, readUnifiedExecMetadata, redactExecFollowUpInput, shouldHideExecFollowUpState, type ExecuteToolCall,
} from "./tools"

export type ScriptToolEntry = { kind: "part"; part: ToolPart } | { kind: "summary"; call: ExecuteToolCall }
type ScriptExplorationGroup = { kind: "exploration"; id: string; entries: ScriptToolEntry[]; counts: { search: number; read: number } }

export function groupScriptTools(parentID: string, entries: readonly ScriptToolEntry[]): Array<ScriptToolEntry | ScriptExplorationGroup> {
  const result: Array<ScriptToolEntry | ScriptExplorationGroup> = []
  let group: ScriptExplorationGroup | undefined
  for (const [index, entry] of entries.entries()) {
    const tool = entry.kind === "part" ? entry.part.tool : entry.call.tool
    if (!isExplorationGroupTool(tool)) {
      group = undefined
      result.push(entry)
      continue
    }
    if (entry.kind === "part" && !isExplorationPartDisplayReady(entry.part)) continue
    if (!group) {
      group = { kind: "exploration", id: `${parentID}:exploration:${entry.kind === "part" ? entry.part.id : index}`, entries: [], counts: { search: 0, read: 0 } }
      result.push(group)
    }
    group.entries.push(entry)
    if (normalizeToolName(tool) === "read") group.counts.read++
    else group.counts.search++
  }
  return result
}

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

const previewSchema = callSchema.pick({ name: true, tool: true, status: true }).extend({
  metadata: z.object({ output: z.string().optional(), execError: z.string().optional() }).optional().catch(undefined),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional().catch(undefined),
})

/** Preserve the message preview action's first-match order without mounting child cards. */
export function* toolPreviewOutputs(part: ToolPart): Generator<string> {
  const state = part.state
  const metadata = state.status === "pending" ? undefined : state.metadata
  const fallback = "output" in state ? state.output : undefined
  const output = isExecCommandTool(part.tool) ? readUnifiedExecMetadata(metadata).output ?? fallback : fallback
  if (output) yield output
  if (!isExecuteTool(part.tool) || !Array.isArray(metadata?.toolCalls)) return
  for (const value of metadata.toolCalls) {
    const parsed = previewSchema.safeParse(value)
    if (!parsed.success) continue
    const call = parsed.data
    const tool = call.name ?? call.tool
    if (shouldHideExecFollowUpState(tool, call.status, call.metadata ?? {})) continue
    const text = isExecCommandTool(tool) && call.metadata?.output !== undefined
      ? call.metadata.output
      : call.content?.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n")
    if (text) yield text
  }
}

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
