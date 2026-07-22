import { describe, expect, test } from "bun:test"
import type { Message } from "@/lib/opencode/model"
import {
  nextUserMessage,
  previousUserMessage,
  selectRevertedMessages,
  selectVisibleMessages,
} from "./message-boundary"

const message = (id: string, role: "user" | "assistant"): Message => {
  const base = { id, sessionID: "ses_1", time: { created: 1 } }
  return role === "user" ? { ...base, role } : { ...base, role, agent: "build", providerID: "test", modelID: "test" }
}

describe("message boundaries", () => {
  const messages = [
    message("msg_z_first", "user"),
    message("msg_y_assistant", "assistant"),
    message("msg_m_boundary", "user"),
    message("msg_b_assistant", "assistant"),
    message("msg_a_last", "user"),
  ]

  test("uses array position when IDs are inverse ordered", () => {
    expect(selectVisibleMessages(messages, "msg_m_boundary").map((item) => item.id)).toEqual([
      "msg_z_first",
      "msg_y_assistant",
    ])
    expect(selectRevertedMessages(messages, "msg_m_boundary").map((item) => item.id)).toEqual([
      "msg_m_boundary",
      "msg_b_assistant",
      "msg_a_last",
    ])
  })

  test("moves undo and restore boundaries between adjacent user messages", () => {
    expect(previousUserMessage(messages, "msg_m_boundary")?.id).toBe("msg_z_first")
    expect(nextUserMessage(messages, "msg_m_boundary")?.id).toBe("msg_a_last")
  })

  test("returns safe empty selections for a missing revert boundary", () => {
    expect(selectVisibleMessages(messages, "msg_missing")).toEqual([])
    expect(selectRevertedMessages(messages, "msg_missing")).toEqual([])
    expect(previousUserMessage(messages, "msg_missing")).toBe(undefined)
    expect(nextUserMessage(messages, "msg_missing")).toBe(undefined)
  })
})
