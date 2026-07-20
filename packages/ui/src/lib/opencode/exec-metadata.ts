import { z } from "zod"
import type { JsonValue, Metadata, ToolPart } from "./model"
import { isExecCommandTool, isExecuteTool } from "./tools"

export type ExecPreview = { revision: number; childID?: string; metadata: Metadata }
export type ScriptPreview = { revision: number; toolCalls: Metadata[] }

const revisionSchema = z.number().int().nonnegative().catch(-1)
const identityFields = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  tool: z.string().optional(),
})
const identitySchema = identityFields.catch({})
const callSchema = identityFields.extend({
  metadata: z.record(z.string(), z.json()).optional(),
}).catch({})
const recordSchema = z.record(z.string(), z.json())

const revision = (metadata: Metadata | undefined, key: "execRevision" | "codeModeRevision") =>
  revisionSchema.parse(metadata?.[key])

function calls(metadata: Metadata | undefined): JsonValue[] {
  const value = metadata?.toolCalls
  return Array.isArray(value) ? value : []
}

function retainChildPreviews(previous: Metadata | undefined, incoming: Metadata): Metadata {
  const previousCalls = calls(previous)
  if (previousCalls.length === 0) return incoming
  const byID = new Map<string, Metadata>()
  for (const value of previousCalls) {
    const identity = identitySchema.parse(value)
    if (!identity.id || !isExecCommandTool(identity.name ?? identity.tool)) continue
    const call = callSchema.parse(value)
    if (call.id && call.metadata) byID.set(call.id, call.metadata)
  }
  let changed = false
  const toolCalls = calls(incoming).map((value): JsonValue => {
    const identity = identitySchema.parse(value)
    const existing = identity.id ? byID.get(identity.id) : undefined
    if (!existing) return value
    const call = callSchema.parse(value)
    if (revision(existing, "execRevision") <= revision(call.metadata, "execRevision")) return value
    const record = recordSchema.safeParse(value)
    if (!record.success) return value
    changed = true
    return { ...record.data, metadata: { ...call.metadata, ...existing } }
  })
  return changed ? { ...incoming, toolCalls } : incoming
}

/** Tool settlement can follow a newer preview. Preserve presentation, never the old tool status or result. */
export function reconcileExecMetadata(tool: string, previous: Metadata | undefined, incoming: Metadata | undefined): Metadata | undefined {
  if (!previous || !incoming) return incoming ?? previous
  if (isExecCommandTool(tool) && revision(previous, "execRevision") > revision(incoming, "execRevision")) {
    return { ...incoming, ...previous }
  }
  if (!isExecuteTool(tool)) return incoming
  const metadata = revision(previous, "codeModeRevision") > revision(incoming, "codeModeRevision")
    ? { ...incoming, toolCalls: previous.toolCalls, codeModeRevision: previous.codeModeRevision }
    : incoming
  return retainChildPreviews(previous, metadata)
}

/** A running command may outlive its completed model tool call. */
export function applyExecPreview(part: ToolPart, preview: ExecPreview): ToolPart {
  const state = part.state
  if (state.status === "pending") return part
  const metadata = { ...preview.metadata, execRevision: preview.revision }
  if (preview.childID === undefined) {
    if (!isExecCommandTool(part.tool) || revision(state.metadata, "execRevision") >= preview.revision) return part
    return { ...part, state: { ...state, metadata: { ...state.metadata, ...metadata } } }
  }
  if (!isExecuteTool(part.tool)) return part
  let changed = false
  const toolCalls = calls(state.metadata).map((value): JsonValue => {
    const identity = identitySchema.parse(value)
    if (identity.id !== preview.childID || !isExecCommandTool(identity.name ?? identity.tool)) return value
    const call = callSchema.parse(value)
    if (revision(call.metadata, "execRevision") >= preview.revision) return value
    const record = recordSchema.safeParse(value)
    if (!record.success) return value
    changed = true
    return { ...record.data, metadata: { ...call.metadata, ...metadata } }
  })
  if (!changed) return part
  return { ...part, state: { ...state, metadata: { ...state.metadata, toolCalls } } }
}

export function applyScriptPreview(part: ToolPart, preview: ScriptPreview): ToolPart {
  const state = part.state
  if (!isExecuteTool(part.tool) || state.status === "pending") return part
  if (revision(state.metadata, "codeModeRevision") >= preview.revision) return part
  const metadata = retainChildPreviews(state.metadata, {
    ...state.metadata,
    toolCalls: preview.toolCalls,
    codeModeRevision: preview.revision,
  })
  return { ...part, state: { ...state, metadata } }
}
