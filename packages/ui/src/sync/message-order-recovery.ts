import { isOpencodeNotFound, type opencodeClient } from "@/lib/opencode/client"
import type { DirectoryRecoverySource } from "./directory-recovery-snapshots"
import { materializeSessionSnapshots, type MaterializedState } from "./materialization"
import { beginMessageSnapshot } from "./message-snapshot"

type MessageOrderSource = DirectoryRecoverySource & { setState: (state: MaterializedState) => void }
type MessageOrderReader = Pick<typeof opencodeClient, "getSessionMessage" | "getSessionMessages">

/** Confirm one provisional record without claiming coverage of the history window. */
export async function recoverMessageOrder(input: {
  source: MessageOrderSource
  reader: MessageOrderReader
  directory: string
  sessionID: string
  messageID: string
  compactionEventSeq?: number
  isCurrent: () => boolean
}): Promise<boolean> {
  const { source, reader, directory, sessionID, messageID, compactionEventSeq } = input
  const snapshot = beginMessageSnapshot(source, sessionID)
  const isCurrent = () => input.isCurrent() && snapshot.isCurrent()
  const provisional = () => source.getState().message[sessionID]?.find((message) => message.id === messageID && message.seq === undefined)
  try {
    if (!isCurrent() || !provisional()) return false
    let record: Awaited<ReturnType<MessageOrderReader["getSessionMessage"]>> | undefined
    try {
      record = await reader.getSessionMessage(sessionID, messageID, directory)
    } catch (error) {
      if (!isCurrent()) return false
      if (compactionEventSeq === undefined || !isOpencodeNotFound(error)) throw error
      // Completion events can omit the original compaction ID. Their event seq
      // is an upper bound, never the creation seq of that original record.
      const seen = new Set<string>()
      let cursor: string | undefined
      do {
        const page = await reader.getSessionMessages(sessionID, { limit: 64, cursor }, directory)
        if (!isCurrent() || !provisional()) return false
        record = page.items.filter((item) => item.info.role === "compaction" && item.info.seq <= compactionEventSeq)
          .sort((a, b) => b.info.seq - a.info.seq)[0]
        if (record) break
        cursor = page.cursor.next
        if (cursor && (seen.has(cursor) || page.items.length === 0)) throw new Error("Compaction recovery history did not advance")
        if (cursor) seen.add(cursor)
      } while (cursor)
      if (!record) throw new Error(`Compaction record not found for ${messageID}`)
    }
    if (!isCurrent() || !provisional()) return false
    const records = snapshot.reconcile([record])
    if (records.length === 0) return false
    const current = source.getState()
    const alias = record.info.id !== messageID
    if (alias && (record.info.role !== "compaction" || provisional()?.role !== "compaction")) {
      throw new Error("Recovered message identity does not match the provisional record")
    }
    const base: MaterializedState = alias ? {
      message: { ...current.message, [sessionID]: current.message[sessionID].filter((message) => message.id !== messageID) },
      part: { ...current.part },
    } : current
    if (alias) delete base.part[messageID]
    const result = materializeSessionSnapshots(base, sessionID, records, { mode: "merge" })
    source.setState({ message: result.message, part: result.part })
    return true
  } finally {
    snapshot.dispose()
  }
}
