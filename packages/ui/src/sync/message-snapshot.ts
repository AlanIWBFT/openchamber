import { syncEventSessionID } from "@/lib/opencode/events"
import type { Message, Part, StoredMessage } from "@/lib/opencode/model"
import { observeDirectoryRecoveryEvents, type DirectoryRecoverySource } from "./directory-recovery-snapshots"

type MessageRecord = { info: Message; parts: Part[] }
type StoredRecord = { info: StoredMessage; parts: Part[] }

/**
 * Protect one history read through publication, including time spent fetching
 * more pages. Creation seq orders messages; it is never an update revision.
 * Only in-flight reads retain these observations, and part IDs are scoped to
 * their owning message (forks can retain the same tool-call IDs).
 */
export function beginMessageSnapshot(source: DirectoryRecoverySource, sessionID: string) {
  const before = source.getState()
  const beforeMessages = new Map((before.message[sessionID] ?? []).map((message) => [message.id, message]))
  const changedMessages = new Set<string>()
  const changedParts = new Map<string, Set<string>>()
  const replacedParts = new Set<string>()
  const removedMessages = new Set<string>()
  let valid = true

  const touchPart = (messageID: string, partID: string) => {
    let parts = changedParts.get(messageID)
    if (!parts) changedParts.set(messageID, parts = new Set())
    parts.add(partID)
  }
  const release = observeDirectoryRecoveryEvents(source, (event) => {
    if (event.type === "location.shutdown") {
      valid = false
      return
    }
    if (syncEventSessionID(event) !== sessionID) return
    switch (event.type) {
      case "session.deleted":
      case "session.revert.committed":
        valid = false
        break
      case "session.patched":
        if (event.properties.patch.time?.archived != null) valid = false
        break
      case "message.updated":
        changedMessages.add(event.properties.info.id)
        removedMessages.delete(event.properties.info.id)
        break
      case "message.patched": {
        const id = event.properties.messageID
        if (!id.startsWith("shell:")) changedMessages.add(id)
        else {
          const shellID = id.slice("shell:".length)
          for (const message of source.getState().message[sessionID] ?? []) {
            if (message.role === "shell" && message.shellID === shellID) changedMessages.add(message.id)
          }
        }
        break
      }
      case "message.removed":
        removedMessages.add(event.properties.messageID)
        break
      case "message.part.updated":
        touchPart(event.properties.part.messageID, event.properties.part.id)
        break
      case "message.part.delta":
      case "message.tool.transition":
        touchPart(event.properties.messageID, event.properties.partID)
        break
      case "message.parts.replaced":
        replacedParts.add(event.properties.messageID)
        break
    }
  })

  return {
    isCurrent: () => valid,
    dispose() {
      valid = false
      release()
    },
    reconcile(records: readonly StoredRecord[], includeConcurrent = false): MessageRecord[] {
      if (!valid) throw new Error(`Message snapshot was invalidated for ${sessionID}`)
      const current = source.getState()
      const messages = new Map((current.message[sessionID] ?? []).map((message) => [message.id, message]))
      const result: MessageRecord[] = []
      for (const record of records) {
        const id = record.info.id
        const existing = messages.get(id)
        if (removedMessages.has(id) || (beforeMessages.has(id) && !existing)) continue
        const messageChanged = changedMessages.has(id) || beforeMessages.get(id) !== existing
        // Even when live state wins, a stored read can confirm creation order.
        const info = existing && messageChanged
          ? existing.seq === record.info.seq ? existing : { ...existing, seq: record.info.seq }
          : record.info
        const currentParts = current.part[id] ?? []
        if (replacedParts.has(id)) {
          result.push({ info, parts: currentParts })
          continue
        }
        const previous = new Map((before.part[id] ?? []).map((part) => [part.id, part]))
        const live = new Map(currentParts.map((part) => [part.id, part]))
        const touched = changedParts.get(id)
        const parts = record.parts.flatMap((part) => {
          const value = live.get(part.id)
          if (!touched?.has(part.id) && previous.get(part.id) === value) return [part]
          if (value) return [value]
          return previous.has(part.id) || touched?.has(part.id) ? [] : [part]
        })
        const ids = new Set(parts.map((part) => part.id))
        for (const part of currentParts) {
          if (!ids.has(part.id) && (touched?.has(part.id) || previous.get(part.id) !== part)) parts.push(part)
        }
        result.push({ info, parts })
      }
      if (!includeConcurrent) return result
      const returned = new Set(result.map((record) => record.info.id))
      for (const message of messages.values()) {
        if (returned.has(message.id) || removedMessages.has(message.id)) continue
        const pendingInput = message.seq === undefined && (message.role === "user" || message.role === "synthetic")
        if (!pendingInput && !changedMessages.has(message.id)
          && beforeMessages.get(message.id) === message && !changedParts.has(message.id) && !replacedParts.has(message.id)) continue
        result.push({ info: message, parts: current.part[message.id] ?? [] })
      }
      return result
    },
  }
}

export type MessageSnapshot = ReturnType<typeof beginMessageSnapshot>
