import { z } from "zod"

// An empty status map grants idle authority; null, arrays, or malformed entries
// must never be accepted as an empty successful response by a recovery caller.
export const sessionStatusSnapshotSchema = z.record(z.string().min(1), z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({
    type: z.literal("retry"), attempt: z.number(), message: z.string(), next: z.number(),
    action: z.object({
      reason: z.string(), provider: z.string(), title: z.string(), message: z.string(), label: z.string(), link: z.string().optional(),
    }).optional(),
    resolution: z.object({
      kind: z.enum(["rate_limited", "usage_limited", "plan_not_included", "quota_exceeded", "policy_blocked", "authentication", "invalid_input", "network", "server"]),
      retry: z.enum(["automatic", "never"]),
      action: z.enum(["switch_model", "wait", "manage_billing", "reauthenticate", "fix_input", "check_network", "retry"]),
      retryAfterMs: z.number().int().nonnegative().optional(),
      providerCode: z.string().optional(),
    }).optional(),
  }),
]))
