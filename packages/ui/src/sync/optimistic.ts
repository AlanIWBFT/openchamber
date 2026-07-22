import type { Message, Part } from "@/lib/opencode/model"
import { sortMessagesChronologically } from "./message-ordering"

function filterIdentifiedParts(parts: Part[]): Part[] {
  return parts.filter((part) => !!part?.id)
}

export type OptimisticItem = {
  message: Message
  parts: Part[]
}

export type MessagePage = {
  session: Message[]
  part: { id: string; part: Part[] }[]
  recentBoundary?: number
  cursor?: string
  complete: boolean
}

const mergeParts = (parts: Part[] | undefined, want: Part[]) => {
  if (!parts) return filterIdentifiedParts(want)
  const ids = new Set(parts.map((part) => part.id))
  const additions = want.filter((part) => {
    if (!part.id || ids.has(part.id)) return false
    ids.add(part.id)
    return true
  })
  return additions.length ? [...parts, ...additions] : parts
}

export function mergeOptimisticPage(
  page: MessagePage,
  items: OptimisticItem[],
) {
  const confirmed: string[] = []
  if (items.length === 0) return { ...page, confirmed }

  const session = [...page.session]
  const part = new Map(page.part.map((item) => [item.id, filterIdentifiedParts(item.part)]))
  const persistedIDs = new Set(session.filter((message) => message.seq !== undefined).map((message) => message.id))

  for (const item of items) {
    if (persistedIDs.has(item.message.id)) {
      confirmed.push(item.message.id)
      continue
    }
    const found = session.some((message) => message.id === item.message.id)
    if (!found) session.push(item.message)

    const current = part.get(item.message.id)
    part.set(item.message.id, mergeParts(current, item.parts))
  }

  return {
    cursor: page.cursor,
    complete: page.complete,
    recentBoundary: page.recentBoundary,
    session: sortMessagesChronologically(session),
    part: [...part.entries()]
      .map(([id, part]) => ({ id, part })),
    confirmed,
  }
}

/** Merge reconciled snapshots by identity and persisted order, retaining equal references. */
export function mergeMessages<T extends Message>(
  a: T[],
  b: readonly T[],
) {
  const byID = new Map(a.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of b) {
    const existing = byID.get(item.id)
    if (existing === item || (existing && JSON.stringify(existing) === JSON.stringify(item))) continue
    byID.set(item.id, item)
    changed = true
  }
  const sorted = sortMessagesChronologically([...byID.values()])
  return !changed && sorted.every((item, index) => item === a[index]) ? a : sorted
}
