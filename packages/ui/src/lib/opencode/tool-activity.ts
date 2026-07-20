import { z } from "zod"
import type { Part } from "./model"
import { isExecuteTool } from "./tools"

const patchTextSchema = z.string().regex(/\S/)
const patchSchema = z.union([patchTextSchema, z.object({ patch: patchTextSchema }).transform((value) => value.patch)])
const optionalText = z.string().trim().min(1).optional().catch(undefined)
const optionalCount = z.number().int().nonnegative().optional().catch(undefined)
const fileSchema = z.object({
  file: optionalText,
  filePath: optionalText,
  relativePath: optionalText,
  movePath: optionalText,
  type: optionalText,
  status: optionalText,
  patch: patchSchema.optional().catch(undefined),
  diff: patchSchema.optional().catch(undefined),
  additions: optionalCount,
  deletions: optionalCount,
})
// Parse only reporting fields, never command output, Script code or child content.
const metadataSchema = z.object({
  files: z.array(fileSchema.nullable().catch(null)).optional().catch(undefined),
  filediff: fileSchema.optional().catch(undefined),
  patch: patchSchema.optional().catch(undefined),
  diff: patchSchema.optional().catch(undefined),
  sessionID: optionalText,
  sessionId: optionalText,
  exit: z.number().optional().catch(undefined),
  exitCode: z.number().optional().catch(undefined),
  processRunning: z.boolean().optional().catch(undefined),
  execError: z.string().optional().catch(undefined),
})
const inputSchema = z.object({ path: optionalText, filePath: optionalText, file_path: optionalText })
const callSchema = z.object({
  id: optionalText,
  name: optionalText,
  tool: z.string(),
  status: z.enum(["pending", "running", "completed", "error"]),
  input: inputSchema.optional().catch(undefined),
  metadata: metadataSchema.optional().catch(undefined),
})
type ActivityCall = {
  id: string
  tool: string
  status: z.infer<typeof callSchema>["status"]
  input?: z.infer<typeof inputSchema>
  metadata?: z.infer<typeof metadataSchema>
}

/** A reporting projection, not extra transcript parts. Child IDs remain scoped to their parent. */
export function* activityToolCalls(parts: readonly Part[]): Generator<ActivityCall> {
  for (const part of parts) {
    if (part.type !== "tool") continue
    const state = part.state
    const metadata = state.status === "pending" ? undefined : state.metadata
    yield { id: part.callID || part.id, tool: part.tool, status: state.status,
      input: inputSchema.safeParse(state.input).data, metadata: metadataSchema.safeParse(metadata).data }
    if (!isExecuteTool(part.tool)) continue
    const calls = metadata?.toolCalls
    if (!Array.isArray(calls)) continue
    for (const [index, value] of calls.entries()) {
      const parsed = callSchema.safeParse(value)
      if (!parsed.success) continue
      const call = parsed.data
      yield { id: `${part.id}:child:${call.id ?? index}`, tool: call.name ?? call.tool, status: call.status,
        input: call.input, metadata: call.metadata }
    }
  }
}
