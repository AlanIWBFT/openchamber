import type { Message } from "@/lib/opencode/model"
import { findMessageIndex } from "./message-ordering"

export function findMessageBoundary(messages: readonly Message[], messageID: string | undefined): number {
  if (!messageID) return -1
  return findMessageIndex(messages, messageID)
}

export function selectVisibleMessages(messages: Message[], messageID: string | undefined): Message[] {
  if (!messageID) return messages
  const boundary = findMessageBoundary(messages, messageID)
  return boundary < 0 ? [] : messages.slice(0, boundary)
}

export function selectRevertedMessages(messages: readonly Message[], messageID: string | undefined): Message[] {
  if (!messageID) return []
  const boundary = findMessageBoundary(messages, messageID)
  return boundary < 0 ? [] : messages.slice(boundary)
}

export function previousUserMessage(messages: readonly Message[], messageID: string): Message | undefined {
  const boundary = findMessageBoundary(messages, messageID)
  if (boundary < 0) return undefined
  for (let index = boundary - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages[index]
  }
  return undefined
}

export function nextUserMessage(messages: readonly Message[], messageID: string): Message | undefined {
  const boundary = findMessageBoundary(messages, messageID)
  if (boundary < 0) return undefined
  // A revert marker can precede its user message on attached synthetic context.
  let foundRevertedUser = false
  for (let index = boundary; index < messages.length; index += 1) {
    if (messages[index]?.role !== "user") continue
    if (foundRevertedUser) return messages[index]
    foundRevertedUser = true
  }
  return undefined
}
