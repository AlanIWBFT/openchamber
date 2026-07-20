import { z } from "zod"
import type { Metadata, Part } from "./model"
import { OPENCODE_TOOLS } from "./builtin-tool-names"
import type { ToolName } from "./tool-name"

const groupTools = new Set<string>([OPENCODE_TOOLS.read, OPENCODE_TOOLS.glob, OPENCODE_TOOLS.grep, "list"])
export const isExplorationGroupTool = (tool: ToolName): boolean => groupTools.has(tool?.trim().toLowerCase().replace(/:\d+$/, "") ?? "")
export const isExplorationPartDisplayReady = (part: Part): boolean => part.type === "tool"
  && (part.state.status !== "completed" || part.state.time.end >= part.state.time.start)

const readDisplay = z.object({ type: z.enum(["file", "directory"]) })
type ReadOutputHeader = { type: "file" | "directory"; length: number }
export function readToolOutputHeader(output: string): ReadOutputHeader | undefined {
  const match = output.match(/^Read (file|directory) .+, (?:0 (?:lines|entries)|(?:lines|entries) \d+-\d+)(?:\r?\n|$)/)
  const type = match?.[1]
  if (match && (type === "file" || type === "directory")) return { type, length: match[0].length }
}

export function getReadToolDisplayType(metadata: Metadata | undefined, output: string | undefined): "file" | "directory" | "unknown" {
  const display = readDisplay.safeParse(metadata?.display)
  if (display.success) return display.data.type
  const header = output ? readToolOutputHeader(output) : undefined
  if (header) return header.type
  const tag = output?.match(/<type>(file|directory)<\/type>/i)?.[1]?.toLowerCase()
  return tag === "file" || tag === "directory" ? tag : "unknown"
}
