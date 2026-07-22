import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { mergeOrdered, sortMessages, sortParts, type MessageOrderState } from "./message-order"

export type OptimisticItem = {
  message: Message
  parts: Part[]
}

export type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  messageSeq?: Map<string, number>
  partSeq?: Map<string, number>
  recentBoundary?: number
  cursor?: string
  complete: boolean
}

const mergeParts = (parts: Part[] | undefined, want: Part[], order: MessageOrderState) => {
  if (!parts) return sortParts(want, order)
  return mergeOrdered(parts, want, order.part)
}

export function mergeOptimisticPage(
  page: MessagePage,
  items: OptimisticItem[],
  order: MessageOrderState,
) {
  if (items.length === 0) return { ...page, confirmed: [] as string[] }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, sortParts(item.part, order)]))
  const confirmed: string[] = []

  for (const item of items) {
    if (order.message.has(item.message.id)) {
      confirmed.push(item.message.id)
      continue
    }
    const found = session.some((message) => message.id === item.message.id)
    if (!found) session.push(item.message)

    const current = part.get(item.message.id)
    part.set(item.message.id, mergeParts(current, item.parts, order))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    messageSeq: page.messageSeq,
    partSeq: page.partSeq,
    recentBoundary: page.recentBoundary,
    session: sortMessages(session, order),
    part: [...part.entries()]
      .map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Merge two sorted message arrays by id, deduplicating.
 *  Preserves references from `a` for items that already exist — avoids
 *  unnecessary React re-renders when prepending older history. */
export function mergeMessages<T extends { id: string }>(
  a: readonly T[],
  b: readonly T[],
  order: MessageOrderState,
) {
  return mergeOrdered(a, b, order.message)
}
