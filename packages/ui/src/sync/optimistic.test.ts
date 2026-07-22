import { describe, expect, test } from "bun:test"
import type { TextPart, UserMessage } from "@/lib/opencode/model"
import { mergeMessages, mergeOptimisticPage } from "./optimistic"

const message: UserMessage = { id: "msg_user", sessionID: "ses_1", role: "user", time: { created: 100 } }
const part: TextPart = { id: "local_text", sessionID: "ses_1", messageID: message.id, type: "text", text: "hello" }

describe("optimistic confirmation", () => {
  test("persisted sequence confirms a message even when the server replaces local part IDs", () => {
    const stored = { ...message, seq: 8 }
    const canonical = { ...part, id: "msg_user:user-text" }
    const result = mergeOptimisticPage({ session: [stored], part: [{ id: message.id, part: [canonical] }], complete: true }, [{ message, parts: [part] }])
    expect(result.confirmed).toEqual([message.id])
    expect(result.part).toEqual([{ id: message.id, part: [canonical] }])
    expect(result.session).toEqual([stored])
  })

  test("an undelivered inbox echo is not persisted confirmation", () => {
    const result = mergeOptimisticPage({ session: [message], part: [{ id: message.id, part: [part] }], complete: true }, [{ message, parts: [part] }])
    expect(result.confirmed).toEqual([])
    expect(result.part[0].part).toEqual([part])
  })

  test("a reconciled stored snapshot replaces a provisional message and moves it to persisted order", () => {
    const later = { ...message, id: "later", seq: 12 }
    const stored = { ...message, seq: 8, time: { created: 200 } }
    const merged = mergeMessages([later, message], [stored])
    expect(merged).toEqual([stored, later])
    expect(mergeMessages(merged, [{ ...stored }])).toBe(merged)
  })
})
