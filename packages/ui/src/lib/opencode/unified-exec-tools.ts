import { z } from "zod"
import type { Metadata, ToolInput } from "./model"
import { OPENCODE_TOOLS } from "./builtin-tool-names"
import { normalizeToolName, type ToolName } from "./tool-name"

export const isExecCommandTool = (tool: ToolName) => normalizeToolName(tool) === OPENCODE_TOOLS.execCommand
export const isWriteStdinTool = (tool: ToolName) => normalizeToolName(tool) === OPENCODE_TOOLS.writeStdin
const controls = new Set<string>([OPENCODE_TOOLS.pollExec, OPENCODE_TOOLS.writeStdin, OPENCODE_TOOLS.terminateExec])
export const isExecFollowUpTool = (tool: ToolName) => controls.has(normalizeToolName(tool))
export const isUnifiedExecTool = (tool: ToolName) => isExecCommandTool(tool) || isExecFollowUpTool(tool)
export const isShellTool = (tool: ToolName) => normalizeToolName(tool) === OPENCODE_TOOLS.shell || isExecCommandTool(tool)

const text = z.string().optional().catch(undefined)
const flag = z.boolean().optional().catch(undefined)
const number = z.number().optional().catch(undefined)
const count = z.number().int().nonnegative().optional().catch(undefined)
const schema = z.object({
  command: text,
  output: text,
  interactions: z.array(z.object({ type: z.enum(["stdin", "terminate"]), time: z.number() })).optional().catch(undefined),
  sessionID: count,
  execID: count,
  laneID: count,
  shellGeneration: count,
  shellReused: flag,
  cwd: text,
  sessionExposed: flag,
  startedAt: number,
  durationMs: number,
  processRunning: flag,
  exitCode: number,
  outputError: text,
  truncated: flag,
  terminationRequested: flag,
  execDisplay: z.enum(["root", "poll", "stdin", "terminate"]).optional().catch(undefined),
  execError: text,
}).catch({})
const inputSchema = z.object({ cmd: text, command: text, chars: text, close_stdin: flag }).catch({})

export type UnifiedExecMetadata = z.infer<typeof schema>
export const readUnifiedExecMetadata = (value: Metadata | undefined) => schema.parse(value)
export const readUnifiedExecInput = (input: ToolInput | undefined) => inputSchema.parse(input)
export function redactExecFollowUpInput(tool: ToolName, input: ToolInput | undefined) {
  if (!input || !isExecFollowUpTool(tool)) return input
  const safeInput = { ...input }
  delete safeInput.chars
  return safeInput
}
export const shouldHideExecFollowUpState = (tool: ToolName, status: string | undefined, metadata: UnifiedExecMetadata) =>
  isExecFollowUpTool(tool) && status !== "error" && !metadata.execError
