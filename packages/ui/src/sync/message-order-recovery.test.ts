import { describe, expect, test } from "bun:test"
import { createStore } from "zustand/vanilla"
import { OpencodeApiError, type MessagePage } from "@/lib/opencode/client"
import type { AssistantMessage, CompactionMessage, StoredMessage } from "@/lib/opencode/model"
import { INITIAL_STATE, type State } from "./types"
import { recordDirectoryRecoveryEvent } from "./directory-recovery-snapshots"
import { recoverMessageOrder } from "./message-order-recovery"

const assistant: AssistantMessage = {
  id: "assistant", sessionID: "session", role: "assistant", time: { created: 100 },
  agent: "build", providerID: "test", modelID: "test",
}
const compaction = (id: string, seq?: number): CompactionMessage => ({
  id, seq, sessionID: "session", role: "compaction", time: { created: 100 }, reason: "manual", status: "completed", summary: "summary",
})
const source = (messages: State["message"][string]) => createStore<State>(() => ({ ...INITIAL_STATE, message: { session: messages } }))
const noPages = async (): Promise<MessagePage> => { throw new Error("Unexpected history request") }
const missing = async (): Promise<MessagePage["items"][number]> => { throw new OpencodeApiError("test", "not found", { status: 404 }) }

describe("authoritative message order recovery", () => {
  test("confirms creation order while keeping concurrent completion and existing history", async () => {
    const older: StoredMessage = { ...assistant, id: "older", seq: 1 }
    const store = source([older, assistant])
    const finished: AssistantMessage = { ...assistant, time: { created: 100, completed: 200 } }
    const result = await recoverMessageOrder({
      source: store, directory: "/project", sessionID: "session", messageID: assistant.id, isCurrent: () => true,
      reader: { getSessionMessages: noPages, getSessionMessage: async () => {
        recordDirectoryRecoveryEvent(store, { type: "message.updated", properties: { info: finished } })
        store.setState({ message: { session: [older, finished] } })
        return { info: { ...assistant, seq: 3 }, parts: [] }
      } },
    })
    expect(result).toBe(true)
    expect(store.getState().message.session).toEqual([older, { ...finished, seq: 3 }])
  })

  test("replaces a terminal alias with the old compaction, excluding a newer compaction", async () => {
    const newer: StoredMessage = { ...compaction("newer"), seq: 30 }
    const original: StoredMessage = { ...compaction("original"), seq: 5 }
    const alias = compaction("event-alias")
    const store = source([newer, alias])
    store.setState({ part: { "event-alias": [] } })
    const cursors: (string | undefined)[] = []
    await recoverMessageOrder({
      source: store, directory: "/project", sessionID: "session", messageID: alias.id, compactionEventSeq: 20, isCurrent: () => true,
      reader: { getSessionMessage: missing, getSessionMessages: async (_session, options) => {
        cursors.push(options?.cursor)
        return options?.cursor
          ? { items: [{ info: original, parts: [] }], cursor: {} }
          : { items: [{ info: newer, parts: [] }], cursor: { next: "older" } }
      } },
    })
    expect(cursors).toEqual([undefined, "older"])
    expect(store.getState().message.session).toEqual([original, newer])
    expect(store.getState().part[alias.id]).toBeUndefined()
  })

  test("a revert during the read invalidates publication", async () => {
    const store = source([assistant])
    const before = store.getState()
    expect(await recoverMessageOrder({
      source: store, directory: "/project", sessionID: "session", messageID: assistant.id, isCurrent: () => true,
      reader: { getSessionMessages: noPages, getSessionMessage: async () => {
        recordDirectoryRecoveryEvent(store, { type: "session.revert.committed", properties: { sessionID: "session", to: assistant.id } })
        return { info: { ...assistant, seq: 3 }, parts: [] }
      } },
    })).toBe(false)
    expect(store.getState()).toBe(before)
  })

  test("owner retirement and failed reads preserve provisional state", async () => {
    const store = source([assistant])
    const before = store.getState()
    let current = true
    const input = { source: store, directory: "/project", sessionID: "session", messageID: assistant.id, isCurrent: () => current }
    expect(await recoverMessageOrder({ ...input, reader: { getSessionMessages: noPages, getSessionMessage: async () => {
      current = false
      return { info: { ...assistant, seq: 3 }, parts: [] }
    } } })).toBe(false)
    current = true
    await expect(recoverMessageOrder({ ...input, reader: { getSessionMessage: missing, getSessionMessages: noPages } })).rejects.toThrow("not found")
    expect(store.getState()).toBe(before)
  })
})
