import { describe, expect, test } from "bun:test"
import type { Message, Part, StoredMessageWithParts } from "@opencode-ai/sdk/v2/client"
import {
  SequenceProtocolError,
  createMessageOrderState,
  decodeStoredMessageRecords,
  preserveConcurrentMessageChanges,
  beginMessageSnapshot,
  assertCurrentMessageOrderState,
  assertCurrentMessageSnapshot,
  clearMessageOrderState,
  getMessageOrderState,
  isCurrentMessageSnapshot,
  touchMessageOrder,
  touchPartOrder,
  dropMessageOrder,
  dropSessionOrder,
  appendConcurrentMessagesMissingFromSnapshot,
  applyDecodedSequences,
  requireEventSequence,
  mergeOrdered,
  sortMessages,
  sortParts,
  upsertOrdered,
} from "./message-order"

const message = (id: string, seq?: number): Message & { seq?: number } => ({
  id,
  sessionID: "ses_1",
  role: "user",
  time: { created: 1 },
  ...(seq === undefined ? {} : { seq }),
} as Message & { seq?: number })

const part = (id: string, messageID: string, seq?: number): Part & { seq?: number } => ({
  id,
  sessionID: "ses_1",
  messageID,
  type: "text",
  text: id,
  ...(seq === undefined ? {} : { seq }),
} as Part & { seq?: number })

describe("message order", () => {
  test("decodes negative and zero sequences and strips them from UI entities", () => {
    const decoded = decodeStoredMessageRecords([
      { info: message("msg_z", -1), parts: [part("prt_z", "msg_z", 0)] },
    ] as StoredMessageWithParts[])

    expect(decoded.messageSeq.get("msg_z")).toBe(-1)
    expect(decoded.partSeq.get("prt_z")).toBe(0)
    expect("seq" in decoded.records[0].info).toBe(false)
    expect("seq" in decoded.records[0].parts[0]).toBe(false)
  })

  test("sorts inverse IDs by authoritative sequence", () => {
    const order = createMessageOrderState()
    order.message.set("msg_z", 1)
    order.message.set("msg_a", 2)
    order.part.set("prt_z", 1)
    order.part.set("prt_a", 2)

    expect(sortMessages([message("msg_a"), message("msg_z")], order).map((item) => item.id)).toEqual(["msg_z", "msg_a"])
    expect(sortParts([part("prt_a", "msg_z"), part("prt_z", "msg_z")], order).map((item) => item.id)).toEqual(["prt_z", "prt_a"])
  })

  test("keeps optimistic entities after persisted entities and repositions on confirmation", () => {
    const order = createMessageOrderState()
    order.message.set("msg_z", 5)
    const optimistic = message("msg_a")
    expect(sortMessages([optimistic, message("msg_z")], order).map((item) => item.id)).toEqual(["msg_z", "msg_a"])

    order.message.set("msg_a", 1)
    expect(upsertOrdered([message("msg_z"), optimistic], optimistic, order.message).map((item) => item.id)).toEqual(["msg_a", "msg_z"])
  })

  test("rejects missing stored and event sequences", () => {
    expect(() => decodeStoredMessageRecords([
      { info: message("msg_1"), parts: [] },
    ] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
    expect(() => requireEventSequence({} as { seq?: unknown }, "Message msg_1")).toThrow(SequenceProtocolError)
  })

  test("rejects malformed stored records instead of treating them as empty", () => {
    expect(() => decodeStoredMessageRecords([{}] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
    expect(() => decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [{}],
    }] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
  })

  test("rejects cross-session and duplicate stored identities or sequences", () => {
    expect(() => decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [],
    }] as StoredMessageWithParts[], new Set(), "ses_other")).toThrow(SequenceProtocolError)
    expect(() => decodeStoredMessageRecords([
      { info: message("msg_1", 1), parts: [] },
      { info: message("msg_1", 2), parts: [] },
    ] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
    expect(() => decodeStoredMessageRecords([
      { info: message("msg_1", 1), parts: [] },
      { info: message("msg_2", 1), parts: [] },
    ] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
    expect(() => decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_1", "msg_1", 1), part("prt_2", "msg_1", 1)],
    }] as StoredMessageWithParts[])).toThrow(SequenceProtocolError)
  })

  test("validates sequence on filtered parts without retaining their order", () => {
    expect(() => decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_hidden", "msg_1")],
    }] as StoredMessageWithParts[], new Set(["text"]))).toThrow(SequenceProtocolError)

    const decoded = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_hidden", "msg_1", 2)],
    }] as StoredMessageWithParts[], new Set(["text"]))
    expect(decoded.records[0].parts).toEqual([])
    expect(decoded.partSeq.has("prt_hidden")).toBe(false)
  })

  test("reorders unchanged entities when authoritative sequence changes", () => {
    const order = createMessageOrderState()
    const first = message("msg_z")
    const second = message("msg_a")
    order.message.set(first.id, 2)
    order.message.set(second.id, 1)

    expect(mergeOrdered([first, second], [first, second], order.message).map((item) => item.id)).toEqual(["msg_a", "msg_z"])
  })

  test("applies multi-entity sequence changes atomically", () => {
    const order = createMessageOrderState()
    applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_a", 1), parts: [] },
      { info: message("msg_b", 2), parts: [] },
    ] as StoredMessageWithParts[]))

    applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_a", 2), parts: [] },
      { info: message("msg_b", 3), parts: [] },
    ] as StoredMessageWithParts[]))

    expect(order.message.get("msg_a")).toBe(2)
    expect(order.message.get("msg_b")).toBe(3)

    const revision = order.revision
    expect(() => applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_new", 2), parts: [] },
    ] as StoredMessageWithParts[]))).toThrow(SequenceProtocolError)
    expect(order.message.has("msg_new")).toBe(false)
    expect(order.revision).toBe(revision)
  })

  test("rejects moving an existing identity to another session", () => {
    const order = createMessageOrderState()
    applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_1", 1), parts: [part("prt_1", "msg_1", 1)] },
    ] as StoredMessageWithParts[]))
    const otherMessage = { ...message("msg_1", 2), sessionID: "ses_other" }
    const otherPart = { ...part("prt_1", "msg_1", 2), sessionID: "ses_other" }

    expect(() => applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: otherMessage, parts: [otherPart] },
    ] as StoredMessageWithParts[], new Set(), "ses_other"))).toThrow("already owned")
    expect(order.message.get("msg_1")).toBe(1)
    expect(order.part.get("prt_1")).toBe(1)
  })

  test("rejects moving an existing part identity to another message", () => {
    const order = createMessageOrderState()
    applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_1", 1), parts: [part("prt_1", "msg_1", 1)] },
    ] as StoredMessageWithParts[]))

    expect(() => applyDecodedSequences(order, decodeStoredMessageRecords([
      { info: message("msg_2", 2), parts: [part("prt_1", "msg_2", 1)] },
    ] as StoredMessageWithParts[]))).toThrow("already owned")
    expect(order.partMessage.get("prt_1")).toBe("msg_1")
  })

  test("preserves same-sequence live content over a stale HTTP snapshot", () => {
    const order = createMessageOrderState()
    order.message.set("msg_1", 1)
    order.part.set("prt_1", 2)
    const revision = beginMessageSnapshot(order, "ses_1")
    const liveMessage = { ...message("msg_1"), agent: "live" } as Message
    const livePart = { ...part("prt_1", "msg_1"), text: "live" } as Part
    touchMessageOrder(order, "msg_1")
    touchPartOrder(order, "prt_1")

    const decoded = decodeStoredMessageRecords([{
      info: { ...message("msg_1", 1), agent: "stale" },
      parts: [{ ...part("prt_1", "msg_1", 2), text: "stale" }],
    }] as StoredMessageWithParts[])
    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      { message: { ses_1: [liveMessage] }, part: { msg_1: [livePart] } },
      "ses_1",
      revision,
    )

    expect((preserved.records[0].info as { agent?: string }).agent).toBe("live")
    expect((preserved.records[0].parts[0] as { text?: string }).text).toBe("live")
  })

  test("preserves a newer HTTP commit over a later same-sequence response", () => {
    const order = createMessageOrderState()
    const olderRevision = beginMessageSnapshot(order, "ses_1")
    const newerRevision = beginMessageSnapshot(order, "ses_1")
    const newer = decodeStoredMessageRecords([{
      info: { ...message("msg_1", 1), agent: "newer" },
      parts: [{ ...part("prt_1", "msg_1", 1), text: "newer" }],
    }] as StoredMessageWithParts[])
    const newerResult = preserveConcurrentMessageChanges(
      order,
      newer,
      { message: {}, part: {} },
      "ses_1",
      newerRevision,
    )
    applyDecodedSequences(order, newerResult)

    const older = decodeStoredMessageRecords([{
      info: { ...message("msg_1", 1), agent: "older" },
      parts: [{ ...part("prt_1", "msg_1", 1), text: "older" }],
    }] as StoredMessageWithParts[])
    const preserved = preserveConcurrentMessageChanges(
      order,
      older,
      {
        message: { ses_1: [newerResult.records[0].info] },
        part: { msg_1: newerResult.records[0].parts },
      },
      "ses_1",
      olderRevision,
    )

    expect((preserved.records[0].info as { agent?: string }).agent).toBe("newer")
    expect((preserved.records[0].parts[0] as { text?: string }).text).toBe("newer")
  })

  test("keeps a recreated same-ID entity over an older in-flight response", () => {
    const order = createMessageOrderState()
    order.message.set("msg_1", 10)
    const recreated = { ...message("msg_1"), agent: "recreated" } as Message
    const decoded = decodeStoredMessageRecords([{
      info: { ...message("msg_1", 1), agent: "stale" },
      parts: [],
    }] as StoredMessageWithParts[])

    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      { message: { ses_1: [recreated] }, part: {} },
      "ses_1",
      beginMessageSnapshot(order, "ses_1"),
    )

    expect((preserved.records[0].info as { agent?: string }).agent).toBe("recreated")
    expect(preserved.messageSeq.get("msg_1")).toBe(10)
  })

  test("does not resurrect parts from a deleted and recreated message", () => {
    const order = createMessageOrderState()
    order.message.set("msg_1", 1)
    order.part.set("prt_old", 1)
    const revision = beginMessageSnapshot(order, "ses_1")
    const decoded = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_old", "msg_1", 1)],
    }] as StoredMessageWithParts[])
    const oldPart = part("prt_old", "msg_1")
    dropMessageOrder(order, "msg_1", [oldPart])
    touchMessageOrder(order, "msg_1")
    touchPartOrder(order, "prt_old")
    order.message.set("msg_1", 2)
    touchMessageOrder(order, "msg_1")
    order.part.set("prt_new", 2)
    touchPartOrder(order, "prt_new")

    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      { message: { ses_1: [message("msg_1")] }, part: { msg_1: [part("prt_new", "msg_1")] } },
      "ses_1",
      revision,
    )

    expect(preserved.records[0].parts.map((item) => item.id)).toEqual(["prt_new"])
  })

  test("clears ownership and revision entries when an entity is removed", () => {
    const order = createMessageOrderState()
    const decoded = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_1", "msg_1", 1)],
    }] as StoredMessageWithParts[])
    applyDecodedSequences(order, decoded)

    dropMessageOrder(order, "msg_1", decoded.records[0].parts)

    expect(order.message.has("msg_1")).toBe(false)
    expect(order.messageRevision.has("msg_1")).toBe(false)
    expect(order.messageSession.has("msg_1")).toBe(false)
    expect(order.messageSequence.size).toBe(0)
    expect(order.part.has("prt_1")).toBe(false)
    expect(order.partRevision.has("prt_1")).toBe(false)
    expect(order.partSession.has("prt_1")).toBe(false)
    expect(order.partMessage.has("prt_1")).toBe(false)
    expect(order.partSequence.size).toBe(0)
  })

  test("removing a message clears sidecar parts absent from the UI snapshot", () => {
    const order = createMessageOrderState()
    const decoded = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [part("prt_orphan", "msg_1", 1)],
    }] as StoredMessageWithParts[])
    applyDecodedSequences(order, decoded)

    dropMessageOrder(order, "msg_1", [])

    expect(order.part.has("prt_orphan")).toBe(false)
    expect(order.partMessage.has("prt_orphan")).toBe(false)
    expect(order.partSequence.size).toBe(0)
  })

  test("invalidates an in-flight snapshot when optimistic state rolls back", () => {
    const order = createMessageOrderState()
    order.messageSession.set("msg_optimistic", "ses_1")
    order.partSession.set("prt_optimistic", "ses_1")
    order.partMessage.set("prt_optimistic", "msg_optimistic")
    touchMessageOrder(order, "msg_optimistic")
    touchPartOrder(order, "prt_optimistic")
    const revision = beginMessageSnapshot(order, "ses_1")

    dropMessageOrder(order, "msg_optimistic", [part("prt_optimistic", "msg_optimistic")])

    expect(() => assertCurrentMessageSnapshot(order, "ses_1", revision)).toThrow("Message snapshot was invalidated")
    expect(order.messageSession.has("msg_optimistic")).toBe(false)
    expect(order.partSession.has("prt_optimistic")).toBe(false)
    expect(order.partMessage.has("prt_optimistic")).toBe(false)
  })

  test("invalidates an in-flight session snapshot after cache eviction", () => {
    const order = createMessageOrderState()
    const revision = beginMessageSnapshot(order, "ses_1")
    const decoded = decodeStoredMessageRecords([{
      info: message("msg_stale", 1),
      parts: [part("prt_stale", "msg_stale", 1)],
    }] as StoredMessageWithParts[])
    order.part.set("prt_orphan", 9)
    order.partSession.set("prt_orphan", "ses_1")
    order.partMessage.set("prt_orphan", "msg_orphan")
    dropSessionOrder(order, "ses_1", [], {
      msg_orphan: [{ ...part("prt_orphan", "msg_orphan"), sessionID: "ses_1" } as Part],
    })

    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      { message: {}, part: {} },
      "ses_1",
      revision,
    )

    expect(preserved.records).toEqual([])
    expect(order.part.has("prt_orphan")).toBe(false)
    expect(order.partSession.has("prt_orphan")).toBe(false)
    expect(order.partMessage.has("prt_orphan")).toBe(false)
    expect(() => assertCurrentMessageSnapshot(order, "ses_1", revision)).toThrow("Message snapshot was invalidated for ses_1")
  })

  test("does not invalidate a snapshot when another session is removed", () => {
    const order = createMessageOrderState()
    const other = { ...message("msg_other"), sessionID: "ses_other" } as Message
    order.messageSession.set(other.id, "ses_other")
    const revision = beginMessageSnapshot(order, "ses_1")
    const otherRevision = beginMessageSnapshot(order, "ses_other")

    dropMessageOrder(order, other.id)

    expect(isCurrentMessageSnapshot(order, "ses_1", revision)).toBe(true)
    expect(isCurrentMessageSnapshot(order, "ses_other", otherRevision)).toBe(false)
    expect(() => assertCurrentMessageSnapshot(order, "ses_other", otherRevision)).toThrow("Message snapshot was invalidated for ses_other")
  })

  test("confirms optimistic content by authoritative identity", () => {
    const order = createMessageOrderState()
    const optimisticMessage = { ...message("msg_1"), agent: "optimistic" } as Message
    const optimisticPart = part("prt_optimistic", "msg_1")
    const revision = beginMessageSnapshot(order, "ses_1")
    touchMessageOrder(order, optimisticMessage.id)
    touchPartOrder(order, optimisticPart.id)
    const decoded = decodeStoredMessageRecords([{
      info: { ...message("msg_1", 1), agent: "server" },
      parts: [{ ...part("prt_server", "msg_1", 1), text: "server" }],
    }] as StoredMessageWithParts[])

    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      { message: { ses_1: [optimisticMessage] }, part: { msg_1: [optimisticPart] } },
      "ses_1",
      revision,
    )

    expect((preserved.records[0].info as { agent?: string }).agent).toBe("server")
    expect(preserved.records[0].parts.map((item) => item.id)).toEqual(["prt_server"])
    expect(preserved.partSeq.has("prt_optimistic")).toBe(false)
  })

  test("preserves unmatched optimistic parts until authoritative parts arrive", () => {
    const order = createMessageOrderState()
    const optimisticText = part("prt_text_optimistic", "msg_1")
    const optimisticFileA = { ...part("prt_file_a", "msg_1"), type: "file" } as Part
    const optimisticFileB = { ...part("prt_file_b", "msg_1"), type: "file" } as Part
    const revision = beginMessageSnapshot(order, "ses_1")
    const decoded = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [{ ...part("prt_file_server", "msg_1", 1), type: "file" } as Part & { seq: number }],
    }] as StoredMessageWithParts[])

    const preserved = preserveConcurrentMessageChanges(
      order,
      decoded,
      {
        message: { ses_1: [message("msg_1")] },
        part: { msg_1: [optimisticText, optimisticFileA, optimisticFileB] },
      },
      "ses_1",
      revision,
    )

    expect(preserved.records[0].parts.map((item) => item.id)).toEqual([
      "prt_file_server",
      "prt_text_optimistic",
      "prt_file_b",
    ])
  })

  test("does not use an already-cached authoritative part to replace another optimistic part", () => {
    const order = createMessageOrderState()
    const serverFile = { ...part("prt_file_server", "msg_1", 1), type: "file" } as Part & { seq: number }
    const optimisticFile = { ...part("prt_file_optimistic", "msg_1"), type: "file" } as Part
    const initial = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [serverFile],
    }] as StoredMessageWithParts[])
    applyDecodedSequences(order, initial)
    const revision = beginMessageSnapshot(order, "ses_1")
    const snapshot = decodeStoredMessageRecords([{
      info: message("msg_1", 1),
      parts: [serverFile],
    }] as StoredMessageWithParts[])

    const preserved = preserveConcurrentMessageChanges(
      order,
      snapshot,
      {
        message: { ses_1: [message("msg_1")] },
        part: { msg_1: [initial.records[0].parts[0], optimisticFile] },
      },
      "ses_1",
      revision,
    )

    expect(preserved.records[0].parts.map((item) => item.id)).toEqual(["prt_file_server", "prt_file_optimistic"])
  })

  test("retains a message created while a recent snapshot is in flight", () => {
    const order = createMessageOrderState()
    const revision = beginMessageSnapshot(order, "ses_1")
    const live = message("msg_live")
    order.message.set(live.id, 3)
    touchMessageOrder(order, live.id)
    const decoded = appendConcurrentMessagesMissingFromSnapshot(
      order,
      { records: [], messageSeq: new Map(), partSeq: new Map() },
      { message: { ses_1: [live] }, part: {} },
      "ses_1",
      revision,
    )

    expect(decoded.records.map((record) => record.info.id)).toEqual(["msg_live"])
    expect(decoded.messageSeq.get("msg_live")).toBe(3)
  })

  test("retains a pre-existing optimistic message during a complete snapshot", () => {
    const order = createMessageOrderState()
    const optimistic = message("msg_optimistic")
    const decoded = appendConcurrentMessagesMissingFromSnapshot(
      order,
      { records: [], messageSeq: new Map(), partSeq: new Map() },
      { message: { ses_1: [optimistic] }, part: {} },
      "ses_1",
      beginMessageSnapshot(order, "ses_1"),
    )

    expect(decoded.records.map((record) => record.info.id)).toEqual(["msg_optimistic"])
    expect(decoded.messageSeq.has("msg_optimistic")).toBe(false)
    applyDecodedSequences(order, decoded)
    expect(order.message.has("msg_optimistic")).toBe(false)
  })

  test("replaces same-ID snapshot content without changing sequence", () => {
    const order = createMessageOrderState()
    order.message.set("msg_1", 1)
    const current = { ...message("msg_1"), agent: "old" } as Message
    const incoming = { ...message("msg_1"), agent: "new" } as Message

    expect((mergeOrdered([current], [incoming], order.message)[0] as { agent?: string }).agent).toBe("new")
  })

  test("invalidates in-flight order state when an instance is replaced", () => {
    const store = {}
    const order = getMessageOrderState(store)
    clearMessageOrderState(store)
    expect(() => assertCurrentMessageOrderState(store, order)).toThrow("Message order state was replaced")
  })
})
