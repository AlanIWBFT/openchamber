import { describe, expect, test } from "bun:test"
import type { Message } from "@/lib/opencode/model"
import {
  insertMessageChronologically,
  messagesBefore,
  messagesFrom,
  sortMessagesChronologically,
} from "./message-ordering"

const message = (id: string, created: number): Message => ({
  id,
  sessionID: "session-a",
  role: "user",
  time: { created },
})

describe("message chronology", () => {
  test("persisted sequence wins over clock reversal and ID rollover, without requiring contiguous values", () => {
    const first = { ...message("msg_ffffffff", 200), seq: 0 }
    const second = { ...message("msg_00000000", 100), seq: 17 }
    expect(sortMessagesChronologically([second, first])).toEqual([first, second])
    const messages = [first]
    insertMessageChronologically(messages, second)
    expect(messages).toEqual([first, second])
  })

  test("provisional messages stay at the tail until their persisted sequence is confirmed", () => {
    const first = { ...message("first", 200), seq: 3 }
    const last = { ...message("last", 300), seq: 9 }
    const pending = message("pending", 100)
    expect(sortMessagesChronologically([pending, last, first])).toEqual([first, last, pending])
    const delivered = { ...pending, seq: 7 }
    expect(sortMessagesChronologically([first, last, delivered])).toEqual([first, delivered, last])
  })

  test("orders post-rollover IDs after legacy IDs by creation time", () => {
    const legacy = message("msg_ffffffffffffLegacy", 100)
    const current = message("msg_000000000000Current", 200)

    expect(sortMessagesChronologically([current, legacy])).toEqual([legacy, current])

    const messages = [legacy]
    insertMessageChronologically(messages, current)
    expect(messages).toEqual([legacy, current])
  })

  test("uses ID only as a deterministic equal-time tie breaker", () => {
    const second = message("msg_b", 100)
    const first = message("msg_a", 100)
    expect(sortMessagesChronologically([second, first])).toEqual([first, second])

    const messages = [second]
    insertMessageChronologically(messages, first)
    expect(messages).toEqual([first, second])
  })

  test("splits a revert branch by marker position instead of ID value", () => {
    const before = message("msg_ffffBefore", 100)
    const marker = message("msg_0000Marker", 200)
    const after = message("msg_0001After", 300)
    const messages = [before, marker, after]

    expect(messagesBefore(messages, marker.id)).toEqual([before])
    expect(messagesFrom(messages, marker.id)).toEqual([marker, after])
  })

  test("does not destructively split when the marker is not materialized", () => {
    const messages = [message("msg_a", 100)]
    expect(messagesBefore(messages, "missing")).toBe(messages)
    expect(messagesFrom(messages, "missing")).toEqual([])
  })
})
