import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import type { AssistantMessage, CompactionMessage, StoredMessage, TextPart, ToolPart } from "@/lib/opencode/model"
import { INITIAL_STATE, type State } from "./types"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { beginMessageSnapshot, invalidateMessageSnapshots } from "./message-snapshot"

const message: AssistantMessage & StoredMessage = {
  id: "msg_1", sessionID: "ses_1", seq: 3, role: "assistant", time: { created: 100 },
  agent: "build", providerID: "test", modelID: "test",
}
const text = (id: string, value: string): TextPart => ({ id, sessionID: "ses_1", messageID: "msg_1", type: "text", text: value })
const tool = (messageID: string, progress: number): ToolPart => ({
  id: "shared-call", callID: "shared-call", sessionID: "ses_1", messageID, type: "tool", tool: "read",
  state: { status: "running", input: {}, time: { start: 100 }, metadata: { progress } },
})
const source = (initial: Partial<State> = {}) => createStore<State>(() => ({ ...INITIAL_STATE, ...initial }))

describe("in-flight message snapshots", () => {
  test("disposing an old read again does not detach the next read from move invalidation", () => {
    const store = source()
    const first = beginMessageSnapshot(store, "ses_1")
    first.dispose()
    const second = beginMessageSnapshot(store, "ses_1")
    try {
      first.dispose()
      invalidateMessageSnapshots(store, "ses_1")
      expect(second.isCurrent()).toBe(false)
      expect(() => second.reconcile([{ info: message, parts: [] }])).toThrow()
    } finally { second.dispose() }
  })
  test("progress on a newer compaction does not block recovery of an older compaction", () => {
    const old: CompactionMessage & StoredMessage = {
      id: "old", sessionID: "ses_1", seq: 3, role: "compaction", time: { created: 100 }, status: "running", reason: "manual", summary: "",
    }
    const newer = { ...old, id: "new", seq: 20 }
    const store = source({ message: { ses_1: [old, newer] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      recordDirectoryRecoveryEvent(store, { type: "message.compaction.delta", properties: { sessionID: "ses_1", delta: "progress" } })
      store.setState({ message: { ses_1: [old, { ...newer, summary: "progress" }] } })
      const completed: CompactionMessage & StoredMessage = { ...old, status: "completed", summary: "final" }
      expect(snapshot.reconcile([{ info: completed, parts: [] }])[0].info).toEqual(completed)
    } finally { snapshot.dispose() }
  })
  test("keeps live changes after a page resolves but before the combined window is published", async () => {
    const old = text("last", "a")
    const store = source({ message: { ses_1: [message] }, part: { msg_1: [old] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      const fetched = await Promise.resolve([{ info: message, parts: [text("first", "history"), old] }])
      const latest = text("last", "ab")
      const appended = text("next", "new")
      recordDirectoryRecoveryEvent(store, { type: "message.part.delta", properties: { sessionID: "ses_1", messageID: "msg_1", partID: "last", field: "text", delta: "b" } })
      recordDirectoryRecoveryEvent(store, { type: "message.part.updated", properties: { sessionID: "ses_1", part: appended } })
      store.setState({ part: { msg_1: [latest, appended] } })
      expect(snapshot.reconcile(fetched)[0].parts).toEqual([text("first", "history"), latest, appended])
    } finally { snapshot.dispose() }
  })

  test("a repeated tool progress event supersedes a stale read even without a reference change", () => {
    const live = tool("msg_1", 2)
    const store = source({ message: { ses_1: [message] }, part: { msg_1: [live] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      recordDirectoryRecoveryEvent(store, { type: "message.tool.transition", properties: {
        sessionID: "ses_1", messageID: "msg_1", partID: live.id, transition: { kind: "progress", metadata: { progress: 2 } },
      } })
      expect(snapshot.reconcile([{ info: message, parts: [tool("msg_1", 1)] }])[0].parts[0]).toBe(live)
    } finally { snapshot.dispose() }
  })

  test("identical tool-call IDs in different messages do not share mutation ownership", () => {
    const second = { ...message, id: "msg_2", seq: 7 }
    const store = source({ message: { ses_1: [message, second] }, part: { msg_1: [tool("msg_1", 1)], msg_2: [tool("msg_2", 1)] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      const live = tool("msg_2", 2)
      recordDirectoryRecoveryEvent(store, { type: "message.tool.transition", properties: {
        sessionID: "ses_1", messageID: "msg_2", partID: live.id, transition: { kind: "progress", metadata: { progress: 2 } },
      } })
      store.setState({ part: { msg_1: store.getState().part.msg_1, msg_2: [live] } })
      const fetchedFirst = tool("msg_1", 3)
      const result = snapshot.reconcile([{ info: message, parts: [fetchedFirst] }, { info: second, parts: [tool("msg_2", 1)] }])
      expect(result[0].parts[0]).toBe(fetchedFirst)
      expect(result[1].parts[0]).toBe(live)
    } finally { snapshot.dispose() }
  })

  test("a live retry wins over earlier attempt information while a stored read confirms creation seq", () => {
    const store = source({ message: { ses_1: [message] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      const retry: AssistantMessage = { ...message, seq: undefined, time: { created: 300 } }
      recordDirectoryRecoveryEvent(store, { type: "message.updated", properties: { info: retry } })
      store.setState({ message: { ses_1: [retry] } })
      expect(snapshot.reconcile([{ info: message, parts: [] }])[0].info).toEqual({ ...retry, seq: 3 })
    } finally { snapshot.dispose() }
  })

  test("a removed message not yet in the local window cannot be resurrected by its pending read", () => {
    const store = source()
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      recordDirectoryRecoveryEvent(store, { type: "message.removed", properties: { sessionID: "ses_1", messageID: "msg_1" } })
      expect(snapshot.reconcile([{ info: message, parts: [] }], true)).toEqual([])
    } finally { snapshot.dispose() }
  })

  test("release is owner-safe and revert invalidates the next in-flight window", () => {
    const store = source()
    const first = beginMessageSnapshot(store, "ses_1")
    first.dispose()
    const second = beginMessageSnapshot(store, "ses_1")
    try {
      first.dispose()
      recordDirectoryRecoveryEvent(store, { type: "session.revert.committed", properties: { sessionID: "ses_1", to: "msg_1" } })
      expect(second.isCurrent()).toBe(false)
      expect(() => second.reconcile([{ info: message, parts: [] }])).toThrow()
    } finally { second.dispose() }
  })

  test("a complete window retains queued input, not an unchanged unconfirmed assistant missing from storage", () => {
    const pending = { id: "queued", sessionID: "ses_1", role: "user" as const, time: { created: 100 } }
    const store = source({ message: { ses_1: [{ ...message, seq: undefined }, pending] } })
    const snapshot = beginMessageSnapshot(store, "ses_1")
    try {
      expect(snapshot.reconcile([], true)).toEqual([{ info: pending, parts: [] }])
    } finally { snapshot.dispose() }
  })
})
