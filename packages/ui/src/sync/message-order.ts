import type { Message, Part, StoredMessageWithParts } from "@opencode-ai/sdk/v2/client"

export class SequenceProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SequenceProtocolError"
  }
}

export type MessageOrderState = {
  message: Map<string, number>
  part: Map<string, number>
  messageSession: Map<string, string>
  partSession: Map<string, string>
  partMessage: Map<string, string>
  messageSequence: Map<string, string>
  partSequence: Map<string, string>
  revision: number
  destructiveRevision: number
  sessionToken: Map<string, object>
  messageRevision: Map<string, number>
  partRevision: Map<string, number>
  valid: boolean
}

const orderByStore = new WeakMap<object, MessageOrderState>()

export function createMessageOrderState(): MessageOrderState {
  return {
    message: new Map(),
    part: new Map(),
    messageSession: new Map(),
    partSession: new Map(),
    partMessage: new Map(),
    messageSequence: new Map(),
    partSequence: new Map(),
    revision: 0,
    destructiveRevision: 0,
    sessionToken: new Map(),
    messageRevision: new Map(),
    partRevision: new Map(),
    valid: true,
  }
}

export function getMessageOrderState(store: object): MessageOrderState {
  const existing = orderByStore.get(store)
  if (existing) return existing
  const created = createMessageOrderState()
  orderByStore.set(store, created)
  return created
}

export function clearMessageOrderState(store: object) {
  const existing = orderByStore.get(store)
  if (existing) existing.valid = false
  orderByStore.delete(store)
}

export function assertCurrentMessageOrderState(store: object, order: MessageOrderState) {
  if (!order.valid || orderByStore.get(store) !== order) throw new Error("Message order state was replaced")
}

export type MessageSnapshot = {
  revision: number
  sessionID: string
  sessionToken: object
  destructiveRevision: number
}

export function assertCurrentMessageSnapshot(order: MessageOrderState, sessionID: string, snapshot: MessageSnapshot) {
  if (!isCurrentMessageSnapshot(order, sessionID, snapshot)) throw new Error(`Message snapshot was invalidated for ${sessionID}`)
}

export function isCurrentMessageSnapshot(order: MessageOrderState, sessionID: string, snapshot: MessageSnapshot) {
  return order.valid && !sessionTouchedAfter(order, sessionID, snapshot)
}

export function beginMessageSnapshot(order: MessageOrderState, sessionID: string): MessageSnapshot {
  const existing = order.sessionToken.get(sessionID)
  const sessionToken = existing ?? {}
  if (!existing) order.sessionToken.set(sessionID, sessionToken)
  return {
    revision: order.revision,
    sessionID,
    sessionToken,
    destructiveRevision: order.destructiveRevision,
  }
}

export function touchMessageOrder(order: MessageOrderState, messageID: string) {
  order.revision += 1
  order.messageRevision.set(messageID, order.revision)
}

function invalidateMessageSnapshots(order: MessageOrderState, sessionID?: string) {
  order.revision += 1
  if (sessionID) {
    order.sessionToken.delete(sessionID)
  } else {
    order.destructiveRevision = order.revision
  }
}

export function invalidateSessionOrder(order: MessageOrderState, sessionID: string) {
  invalidateMessageSnapshots(order, sessionID)
}

export function touchPartOrder(order: MessageOrderState, partID: string) {
  order.revision += 1
  order.partRevision.set(partID, order.revision)
}

export function messageTouchedAfter(order: MessageOrderState, messageID: string, revision: number) {
  return (order.messageRevision.get(messageID) ?? 0) > revision
}

function sessionTouchedAfter(order: MessageOrderState, sessionID: string, snapshot: MessageSnapshot) {
  return snapshot.sessionID !== sessionID
    || order.destructiveRevision > snapshot.destructiveRevision
    || order.sessionToken.get(sessionID) !== snapshot.sessionToken
}

export function partTouchedAfter(order: MessageOrderState, partID: string, revision: number) {
  return (order.partRevision.get(partID) ?? 0) > revision
}

function requireSequence(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new SequenceProtocolError(`${label} sequence is missing or invalid`)
  return value as number
}

export function requireEventSequence(event: { seq?: unknown }, label: string) {
  return requireSequence(event.seq, label)
}

function sequenceKey(sessionID: string, seq: number) {
  return `${sessionID}\0${seq}`
}

function assertAvailableSequence(
  sequence: ReadonlyMap<string, string>,
  id: string,
  sessionID: string,
  seq: number,
  label: string,
) {
  const candidateID = sequence.get(sequenceKey(sessionID, seq))
  if (candidateID && candidateID !== id) {
    throw new SequenceProtocolError(`${label} sequence ${seq} is already used by ${candidateID}`)
  }
}

export function recordMessageSequence(order: MessageOrderState, id: string, sessionID: string, seq: number, label = `Message ${id}`) {
  const previousSeq = order.message.get(id)
  const previousSessionID = order.messageSession.get(id)
  if (previousSessionID && previousSessionID !== sessionID) {
    throw new SequenceProtocolError(`${label} belongs to Session ${sessionID}, already owned by ${previousSessionID}`)
  }
  assertAvailableSequence(order.messageSequence, id, sessionID, seq, label)
  if (previousSeq !== undefined && previousSessionID) {
    const previousKey = sequenceKey(previousSessionID, previousSeq)
    if (order.messageSequence.get(previousKey) === id) order.messageSequence.delete(previousKey)
  }
  order.message.set(id, seq)
  order.messageSession.set(id, sessionID)
  order.messageSequence.set(sequenceKey(sessionID, seq), id)
}

export function recordPartSequence(
  order: MessageOrderState,
  id: string,
  sessionID: string,
  messageID: string,
  seq: number,
  label = `Part ${id}`,
) {
  const previousSeq = order.part.get(id)
  const previousSessionID = order.partSession.get(id)
  const previousMessageID = order.partMessage.get(id)
  if (previousSessionID && previousSessionID !== sessionID) {
    throw new SequenceProtocolError(`${label} belongs to Session ${sessionID}, already owned by ${previousSessionID}`)
  }
  if (previousMessageID && previousMessageID !== messageID) {
    throw new SequenceProtocolError(`${label} belongs to Message ${messageID}, already owned by ${previousMessageID}`)
  }
  assertAvailableSequence(order.partSequence, id, sessionID, seq, label)
  if (previousSeq !== undefined && previousSessionID) {
    const previousKey = sequenceKey(previousSessionID, previousSeq)
    if (order.partSequence.get(previousKey) === id) order.partSequence.delete(previousKey)
  }
  order.part.set(id, seq)
  order.partSession.set(id, sessionID)
  order.partMessage.set(id, messageID)
  order.partSequence.set(sequenceKey(sessionID, seq), id)
}

export type DecodedMessageRecords = {
  records: Array<{ info: Message; parts: Part[] }>
  messageSeq: Map<string, number>
  partSeq: Map<string, number>
}

export function getMessageSequenceBoundary(decoded: DecodedMessageRecords): number | undefined {
  let boundary: number | undefined
  for (const sequence of decoded.messageSeq.values()) {
    if (boundary === undefined || sequence < boundary) boundary = sequence
  }
  return boundary
}

export function decodeStoredMessageRecords(
  input: readonly StoredMessageWithParts[],
  skipPartTypes: ReadonlySet<string> = new Set(),
  expectedSessionID?: string,
): DecodedMessageRecords {
  const messageSeq = new Map<string, number>()
  const partSeq = new Map<string, number>()
  const messageSequences = new Set<number>()
  const partSequences = new Set<number>()
  const partIDs = new Set<string>()
  const records = input.map((record) => {
    if (!record || typeof record !== "object" || !record.info || !Array.isArray(record.parts)) {
      throw new SequenceProtocolError("Stored message record is missing info or parts")
    }
    const rawInfo = record.info as Message & { seq?: unknown }
    if (typeof rawInfo.id !== "string" || rawInfo.id.length === 0) {
      throw new SequenceProtocolError("Stored message identity is missing or invalid")
    }
    if (typeof rawInfo.sessionID !== "string" || rawInfo.sessionID.length === 0) {
      throw new SequenceProtocolError(`Message ${rawInfo.id} session identity is missing or invalid`)
    }
    if (expectedSessionID && rawInfo.sessionID !== expectedSessionID) {
      throw new SequenceProtocolError(`Message ${rawInfo.id} belongs to Session ${rawInfo.sessionID}, expected ${expectedSessionID}`)
    }
    if (messageSeq.has(rawInfo.id)) throw new SequenceProtocolError(`Message ${rawInfo.id} is duplicated`)
    const seq = requireSequence(rawInfo.seq, `Message ${rawInfo.id}`)
    if (messageSequences.has(seq)) throw new SequenceProtocolError(`Message sequence ${seq} is duplicated`)
    messageSequences.add(seq)
    const info = { ...rawInfo } as Message & { seq?: unknown }
    delete info.seq
    messageSeq.set(info.id, seq)

    const parts = record.parts.flatMap((raw) => {
      const stored = raw as Part & { seq?: unknown }
      if (!stored || typeof stored !== "object" || typeof stored.id !== "string" || stored.id.length === 0) {
        throw new SequenceProtocolError("Stored part identity is missing or invalid")
      }
      if (typeof stored.sessionID !== "string" || stored.sessionID !== info.sessionID) {
        throw new SequenceProtocolError(`Part ${stored.id} belongs to Session ${stored.sessionID}, expected ${info.sessionID}`)
      }
      if (stored.messageID !== info.id) {
        throw new SequenceProtocolError(`Part ${stored.id} belongs to Message ${stored.messageID}, expected ${info.id}`)
      }
      if (partIDs.has(stored.id)) throw new SequenceProtocolError(`Part ${stored.id} is duplicated`)
      partIDs.add(stored.id)
      const partSequence = requireSequence(stored.seq, `Part ${stored.id}`)
      if (partSequences.has(partSequence)) throw new SequenceProtocolError(`Part sequence ${partSequence} is duplicated`)
      partSequences.add(partSequence)
      if (skipPartTypes.has(stored.type)) return []
      const part = { ...stored } as Part & { seq?: unknown }
      delete part.seq
      partSeq.set(part.id, partSequence)
      return [part as Part]
    })
    return { info: info as Message, parts }
  })
  return { records, messageSeq, partSeq }
}

export function compareOrdered(leftID: string, rightID: string, sequence: ReadonlyMap<string, number>) {
  const left = sequence.get(leftID)
  const right = sequence.get(rightID)
  if (left === undefined) return right === undefined ? 0 : 1
  if (right === undefined) return -1
  return left - right
}

export function sortMessages(messages: readonly Message[], order: MessageOrderState) {
  return [...messages].sort((left, right) => compareOrdered(left.id, right.id, order.message))
}

export function sortParts(parts: readonly Part[], order: MessageOrderState) {
  return [...parts].sort((left, right) => compareOrdered(left.id, right.id, order.part))
}

export function upsertOrdered<T extends { id: string }>(items: readonly T[], item: T, sequence: ReadonlyMap<string, number>) {
  const next = [...items]
  const current = next.findIndex((candidate) => candidate.id === item.id)
  if (current >= 0) next.splice(current, 1)
  const insertion = next.findIndex((candidate) => compareOrdered(candidate.id, item.id, sequence) > 0)
  next.splice(insertion < 0 ? next.length : insertion, 0, item)
  return next
}

export function mergeOrdered<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  sequence: ReadonlyMap<string, number>,
) {
  const byID = new Map(current.map((item) => [item.id, item] as const))
  let changed = false
  for (const item of incoming) {
    const existing = byID.get(item.id)
    if (existing === item) continue
    if (existing !== undefined) {
      try {
        if (JSON.stringify(existing) === JSON.stringify(item)) continue
      } catch {
        // Replace values that cannot be compared structurally.
      }
    }
    byID.set(item.id, item)
    changed = true
  }
  const sorted = (changed ? [...byID.values()] : [...current])
    .sort((left, right) => compareOrdered(left.id, right.id, sequence))
  if (!changed && sorted.every((item, index) => item === current[index])) return current as T[]
  return sorted
}

type SequenceUpdate = { id: string; sessionID: string; seq: number }

function planSequenceUpdates(
  current: ReadonlyMap<string, number>,
  ownership: ReadonlyMap<string, string>,
  sequence: ReadonlyMap<string, string>,
  incoming: ReadonlyMap<string, number>,
  sessions: ReadonlyMap<string, string>,
  entity: "Message" | "Part",
) {
  const updates: SequenceUpdate[] = []
  for (const [id, seq] of incoming) {
    if (!Number.isSafeInteger(seq)) throw new SequenceProtocolError(`${entity} ${id} sequence is missing or invalid`)
    const sessionID = sessions.get(id)
    if (!sessionID) throw new SequenceProtocolError(`${entity} ${id} session identity is missing or invalid`)
    const currentSessionID = ownership.get(id)
    if (currentSessionID && currentSessionID !== sessionID) {
      throw new SequenceProtocolError(`${entity} ${id} belongs to Session ${sessionID}, already owned by ${currentSessionID}`)
    }
    const currentSeq = current.get(id)
    if (currentSeq !== undefined && seq < currentSeq) continue
    updates.push({ id, sessionID, seq })
  }

  const vacated = new Set<string>()
  for (const update of updates) {
    const previousSeq = current.get(update.id)
    const previousSessionID = ownership.get(update.id)
    if (previousSeq === undefined || !previousSessionID) continue
    const key = sequenceKey(previousSessionID, previousSeq)
    if (sequence.get(key) === update.id) vacated.add(key)
  }
  const claimed = new Map<string, string>()
  for (const update of updates) {
    const key = sequenceKey(update.sessionID, update.seq)
    const claimedID = claimed.get(key)
    if (claimedID && claimedID !== update.id) {
      throw new SequenceProtocolError(`${entity} ${update.id} sequence ${update.seq} is already used by ${claimedID}`)
    }
    const currentID = sequence.get(key)
    if (currentID && currentID !== update.id && !vacated.has(key)) {
      throw new SequenceProtocolError(`${entity} ${update.id} sequence ${update.seq} is already used by ${currentID}`)
    }
    claimed.set(key, update.id)
  }
  return updates
}

export function applyDecodedSequences(order: MessageOrderState, decoded: DecodedMessageRecords) {
  const messageSession = new Map<string, string>()
  const partSession = new Map<string, string>()
  const partMessage = new Map<string, string>()
  for (const record of decoded.records) {
    messageSession.set(record.info.id, record.info.sessionID)
    for (const part of record.parts) {
      partSession.set(part.id, record.info.sessionID)
      partMessage.set(part.id, record.info.id)
    }
  }
  for (const id of decoded.partSeq.keys()) {
    const messageID = partMessage.get(id)
    if (!messageID) throw new SequenceProtocolError(`Part ${id} message identity is missing or invalid`)
    const currentMessageID = order.partMessage.get(id)
    if (currentMessageID && currentMessageID !== messageID) {
      throw new SequenceProtocolError(`Part ${id} belongs to Message ${messageID}, already owned by ${currentMessageID}`)
    }
  }
  const messages = planSequenceUpdates(
    order.message,
    order.messageSession,
    order.messageSequence,
    decoded.messageSeq,
    messageSession,
    "Message",
  )
  const parts = planSequenceUpdates(
    order.part,
    order.partSession,
    order.partSequence,
    decoded.partSeq,
    partSession,
    "Part",
  )

  for (const update of messages) {
    const previousSeq = order.message.get(update.id)
    const previousSessionID = order.messageSession.get(update.id)
    if (previousSeq !== undefined && previousSessionID) {
      const key = sequenceKey(previousSessionID, previousSeq)
      if (order.messageSequence.get(key) === update.id) order.messageSequence.delete(key)
    }
  }
  for (const update of parts) {
    const previousSeq = order.part.get(update.id)
    const previousSessionID = order.partSession.get(update.id)
    if (previousSeq !== undefined && previousSessionID) {
      const key = sequenceKey(previousSessionID, previousSeq)
      if (order.partSequence.get(key) === update.id) order.partSequence.delete(key)
    }
  }
  for (const update of messages) {
    order.message.set(update.id, update.seq)
    order.messageSession.set(update.id, update.sessionID)
    order.messageSequence.set(sequenceKey(update.sessionID, update.seq), update.id)
    touchMessageOrder(order, update.id)
  }
  for (const update of parts) {
    order.part.set(update.id, update.seq)
    order.partSession.set(update.id, update.sessionID)
    order.partMessage.set(update.id, partMessage.get(update.id)!)
    order.partSequence.set(sequenceKey(update.sessionID, update.seq), update.id)
    touchPartOrder(order, update.id)
  }
}

export function preserveConcurrentMessageChanges(
  order: MessageOrderState,
  decoded: DecodedMessageRecords,
  state: { message: Record<string, Message[] | undefined>; part: Record<string, Part[] | undefined> },
  sessionID: string,
  snapshot: MessageSnapshot,
): DecodedMessageRecords {
  if (sessionTouchedAfter(order, sessionID, snapshot)) {
    const records = (state.message[sessionID] ?? []).map((info) => ({ info, parts: state.part[info.id] ?? [] }))
    const messageSeq = new Map<string, number>()
    const partSeq = new Map<string, number>()
    for (const record of records) {
      const sequence = order.message.get(record.info.id)
      if (sequence !== undefined) messageSeq.set(record.info.id, sequence)
      for (const part of record.parts) {
        const partSequence = order.part.get(part.id)
        if (partSequence !== undefined) partSeq.set(part.id, partSequence)
      }
    }
    return { records, messageSeq, partSeq }
  }

  const currentMessages = new Map((state.message[sessionID] ?? []).map((message) => [message.id, message]))
  const records = decoded.records.flatMap((record) => {
    const fetchedMessageSeq = decoded.messageSeq.get(record.info.id)!
    const currentMessageSeq = order.message.get(record.info.id)
    const newerMessage = currentMessageSeq !== undefined && fetchedMessageSeq < currentMessageSeq
    const touchedMessage = messageTouchedAfter(order, record.info.id, snapshot.revision)
    const authoritativeCurrentMessage = currentMessageSeq !== undefined
    const currentMessage = currentMessages.get(record.info.id)
    if ((newerMessage || touchedMessage) && !currentMessage) return []

    const currentParts = new Map((state.part[record.info.id] ?? []).map((part) => [part.id, part]))
    const parts = record.parts.flatMap((part) => {
      const fetchedPartSeq = decoded.partSeq.get(part.id)!
      const currentPartSeq = order.part.get(part.id)
      const newerPart = currentPartSeq !== undefined && fetchedPartSeq < currentPartSeq
      if (!newerPart && !partTouchedAfter(order, part.id, snapshot.revision)) return [part]
      const current = currentParts.get(part.id)
      return current ? [current] : []
    })
    const partIDs = new Set(parts.map((part) => part.id))
    const replacementsByType = new Map<string, number>()
    for (const part of parts) {
      if (!decoded.partSeq.has(part.id) || currentParts.has(part.id)) continue
      replacementsByType.set(part.type, (replacementsByType.get(part.type) ?? 0) + 1)
    }
    for (const current of currentParts.values()) {
      if (partIDs.has(current.id)) continue
      if (!order.part.has(current.id)) {
        const replacements = replacementsByType.get(current.type) ?? 0
        if (replacements > 0) {
          replacementsByType.set(current.type, replacements - 1)
          continue
        }
        parts.push(current)
        continue
      }
      if (!partTouchedAfter(order, current.id, snapshot.revision)) continue
      parts.push(current)
    }
    return [{ info: newerMessage || (touchedMessage && authoritativeCurrentMessage) ? currentMessage! : record.info, parts }]
  })
  const messageIDs = new Set(records.map((record) => record.info.id))
  const partIDs = new Set(records.flatMap((record) => record.parts.map((part) => part.id)))
  const messageSeq = new Map<string, number>()
  for (const id of messageIDs) {
    const fetched = decoded.messageSeq.get(id)
    const current = order.message.get(id)
    if (fetched === undefined && current === undefined) continue
    messageSeq.set(id, fetched === undefined ? current! : current === undefined ? fetched : Math.max(fetched, current))
  }
  const partSeq = new Map<string, number>()
  for (const id of partIDs) {
    const fetched = decoded.partSeq.get(id)
    const current = order.part.get(id)
    if (fetched === undefined && current === undefined) continue
    partSeq.set(id, fetched === undefined ? current! : current === undefined ? fetched : Math.max(fetched, current))
  }
  return {
    records,
    messageSeq,
    partSeq,
  }
}

export function appendConcurrentMessagesMissingFromSnapshot(
  order: MessageOrderState,
  decoded: DecodedMessageRecords,
  state: { message: Record<string, Message[] | undefined>; part: Record<string, Part[] | undefined> },
  sessionID: string,
  snapshot: MessageSnapshot,
): DecodedMessageRecords {
  const returned = new Set(decoded.records.map((record) => record.info.id))
  const additions = (state.message[sessionID] ?? []).filter(
    (message) => !returned.has(message.id) && (
      !order.message.has(message.id)
      || messageTouchedAfter(order, message.id, snapshot.revision)
      || (state.part[message.id] ?? []).some((part) => partTouchedAfter(order, part.id, snapshot.revision))
    ),
  )
  if (additions.length === 0) return decoded

  const records = [...decoded.records, ...additions.map((info) => ({ info, parts: state.part[info.id] ?? [] }))]
  const messageSeq = new Map(decoded.messageSeq)
  const partSeq = new Map(decoded.partSeq)
  for (const message of additions) {
    const seq = order.message.get(message.id)
    if (seq !== undefined) messageSeq.set(message.id, seq)
    for (const part of state.part[message.id] ?? []) {
      const partOrder = order.part.get(part.id)
      if (partOrder !== undefined) partSeq.set(part.id, partOrder)
    }
  }
  return { records, messageSeq, partSeq }
}

function clearPartOrder(order: MessageOrderState, partID: string) {
  const seq = order.part.get(partID)
  const sessionID = order.partSession.get(partID)
  if (seq !== undefined && sessionID) {
    const key = sequenceKey(sessionID, seq)
    if (order.partSequence.get(key) === partID) order.partSequence.delete(key)
  }
  order.part.delete(partID)
  order.partRevision.delete(partID)
  order.partSession.delete(partID)
  order.partMessage.delete(partID)
}

function clearMessageOrder(order: MessageOrderState, messageID: string, parts?: readonly Part[]) {
  const seq = order.message.get(messageID)
  const sessionID = order.messageSession.get(messageID)
  if (seq !== undefined && sessionID) {
    const key = sequenceKey(sessionID, seq)
    if (order.messageSequence.get(key) === messageID) order.messageSequence.delete(key)
  }
  order.message.delete(messageID)
  order.messageRevision.delete(messageID)
  order.messageSession.delete(messageID)
  const partIDs = new Set((parts ?? []).map((part) => part.id))
  for (const [partID, ownerMessageID] of order.partMessage) {
    if (ownerMessageID === messageID) partIDs.add(partID)
  }
  for (const partID of partIDs) clearPartOrder(order, partID)
}

export function dropPartOrder(order: MessageOrderState, partID: string) {
  invalidateMessageSnapshots(order, order.partSession.get(partID))
  clearPartOrder(order, partID)
}

export function dropMessageOrder(order: MessageOrderState, messageID: string, parts?: readonly Part[]) {
  invalidateMessageSnapshots(order, order.messageSession.get(messageID))
  clearMessageOrder(order, messageID, parts)
}

export function dropSessionOrder(
  order: MessageOrderState,
  sessionID: string,
  messages: readonly Message[] | undefined,
  parts: Readonly<Record<string, Part[] | undefined>>,
) {
  invalidateMessageSnapshots(order, sessionID)
  for (const message of messages ?? []) clearMessageOrder(order, message.id, parts[message.id])
  for (const [messageID, owner] of order.messageSession) {
    if (owner !== sessionID) continue
    clearMessageOrder(order, messageID)
  }
  for (const [partID, owner] of order.partSession) {
    if (owner !== sessionID) continue
    clearPartOrder(order, partID)
  }
}
