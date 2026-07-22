import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import type { Event, Message, Part, PermissionRequest, QuestionRequest, SessionStatus } from "@opencode-ai/sdk/v2/client"
import { applyDirectoryEvent } from "../event-reducer"
import { INITIAL_STATE, type State } from "../types"
import { assertCurrentMessageSnapshot, beginMessageSnapshot, createMessageOrderState, recordMessageSequence, recordPartSequence } from "../message-order"

function state(overrides: Partial<State> = {}): State {
  return {
    ...INITIAL_STATE,
    message: {},
    part: {},
    session_status: {},
    ...overrides,
  }
}

function deltaEvent(): Event {
  return {
    type: "message.part.delta",
    properties: {
      messageID: "msg_1",
      partID: "prt_1",
      field: "text",
      delta: "hello",
    },
  } as Event
}

function partUpdatedEvent(): Event {
  return {
    seq: 1,
    type: "message.part.updated",
    properties: {
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function topLevelSessionOnlyPartUpdatedEvent(): Event {
  return {
    seq: 1,
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      part: {
        id: "prt_1",
        messageID: "msg_1",
        type: "text",
        text: "hello",
      },
    },
  } as Event
}

function buildSession(title: string, time: Session["time"]): Session {
  return {
    id: "ses_1",
    title,
    time,
  } as Session
}

describe("applyDirectoryEvent", () => {
  test("inserts post-rollover message events by authoritative sequence rather than ID", () => {
    const legacy = {
      id: "msg_ffffffffffffLegacy",
      sessionID: "ses_1",
      role: "user",
      time: { created: 100 },
    } as Message
    const current = {
      id: "msg_000000000000Current",
      sessionID: "ses_1",
      role: "assistant",
      time: { created: 200 },
    } as Message
    const draft = state({ message: { ses_1: [legacy] } })
    const order = createMessageOrderState()
    recordMessageSequence(order, legacy.id, "ses_1", 1)

    expect(applyDirectoryEvent(draft, {
      seq: 2,
      type: "message.updated",
      properties: { info: current },
    } as Event, { order })).toBe(true)
    expect(draft.message.ses_1).toEqual([legacy, current])
  })

  test("orders part events by authoritative sequence across the part ID rollover", () => {
    const legacyPart = {
      id: "prt_ffffffffffffLegacy",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "legacy",
    } as Part
    const currentPart = {
      id: "prt_000000000000Current",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "text",
      text: "current",
    } as Part
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as Message] },
      part: { msg_1: [legacyPart] },
    })
    const order = createMessageOrderState()
    recordPartSequence(order, legacyPart.id, "ses_1", "msg_1", 1)

    expect(applyDirectoryEvent(draft, {
      seq: 2,
      type: "message.part.updated",
      properties: { part: currentPart },
    } as Event, { order })).toBe(true)
    expect(draft.part.msg_1).toEqual([legacyPart, currentPart])
  })

  test("returns typed materialization when delta arrives before parts", () => {
    const result = applyDirectoryEvent(state(), deltaEvent())

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("returns typed materialization when delta part is missing", () => {
    const result = applyDirectoryEvent(
      state({ part: { msg_1: [{ id: "prt_2", messageID: "msg_1", type: "text", text: "" } as Part] } }),
      deltaEvent(),
    )

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("applies part update and requests materialization when owning message is absent", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, partUpdatedEvent(), { order: createMessageOrderState() })

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id and part message id for part update materialization", () => {
    const draft = state()
    const result = applyDirectoryEvent(draft, topLevelSessionOnlyPartUpdatedEvent(), { order: createMessageOrderState() })

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toEqual({
      changed: true,
      materialization: {
        type: "incomplete-session-snapshot",
        reason: "missing-owning-message",
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
      },
    })
  })

  test("uses top-level session id for delta materialization", () => {
    const result = applyDirectoryEvent(state(), {
      type: "message.part.delta",
      properties: {
        sessionID: "ses_1",
        messageID: "msg_1",
        partID: "prt_1",
        field: "text",
        delta: "hello",
      },
    } as Event)

    expect(result).toEqual({
      changed: false,
      materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: "ses_1", messageID: "msg_1", partID: "prt_1" },
    })
  })

  test("skips stale session.updated events so a newer title survives", () => {
    const draft = state({ session: [buildSession("New Title", { created: 1, updated: 20 })] })

    const result = applyDirectoryEvent(draft, {
      type: "session.updated",
      properties: {
        info: buildSession("Old Title", { created: 1, updated: 10 }),
      },
    } as Event)

    expect(result).toBe(false)
    expect(draft.session[0]?.title).toBe("New Title")
  })

  test("applies part update without materialization when owning message exists", () => {
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", time: { created: 1 } } as never] },
    })
    const result = applyDirectoryEvent(draft, partUpdatedEvent(), { order: createMessageOrderState() })

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_1"])
    expect(result).toBe(true)
  })

  test("orders messages and parts by sequence when IDs are inverse ordered", () => {
    const order = createMessageOrderState()
    const draft = state({
      message: { ses_1: [{ id: "msg_a", sessionID: "ses_1", role: "user", time: { created: 2 } } as never] },
      part: { msg_a: [{ id: "prt_a", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "later" } as Part] },
    })
    order.message.set("msg_a", 2)
    order.part.set("prt_a", 2)

    applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.updated",
      properties: { info: { id: "msg_z", sessionID: "ses_1", role: "user", time: { created: 1 } } },
    } as Event, { order })
    applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_z", messageID: "msg_a", sessionID: "ses_1", type: "text", text: "earlier" },
      },
    } as Event, { order })

    expect(draft.message.ses_1.map((item) => item.id)).toEqual(["msg_z", "msg_a"])
    expect(draft.part.msg_a.map((item) => item.id)).toEqual(["prt_z", "prt_a"])
  })

  test("replaces an optimistic part even when authoritative parts precede it", () => {
    const order = createMessageOrderState()
    const persisted = { id: "prt_persisted", messageID: "msg_1", sessionID: "ses_1", type: "file" } as Part
    const optimistic = { id: "prt_optimistic", messageID: "msg_1", type: "text", text: "hello" } as Part
    order.part.set(persisted.id, 1)
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message] },
      part: { msg_1: [persisted, optimistic] },
    })

    applyDirectoryEvent(draft, {
      seq: 2,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_server", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" },
      },
    } as Event, { order })

    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_persisted", "prt_server"])
    expect(order.partRevision.has("prt_optimistic")).toBe(false)
    expect(order.partSession.has("prt_optimistic")).toBe(false)
  })

  test("does not regress streaming text on a shorter same-sequence update", () => {
    const order = createMessageOrderState()
    const existing = { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "hello" } as Part
    recordPartSequence(order, existing.id, "ses_1", "msg_1", 1)
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1 } } as Message] },
      part: { msg_1: [existing] },
    })

    applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { ...existing, text: "hel" },
      },
    } as Event, { order })
    applyDirectoryEvent(draft, {
      type: "message.part.delta",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_1", field: "text", delta: "lo world" },
    } as Event, { order })

    expect((draft.part.msg_1[0] as { text?: string }).text).toBe("hello world")
  })

  test("does not regress a completed message to incomplete", () => {
    const order = createMessageOrderState()
    const completed = {
      id: "msg_1",
      sessionID: "ses_1",
      role: "assistant",
      parentID: "msg_user",
      time: { created: 1, completed: 2 },
      finish: "stop",
    } as Message
    recordMessageSequence(order, completed.id, "ses_1", 1)
    const draft = state({ message: { ses_1: [completed] } })

    const changed = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.updated",
      properties: { info: { ...completed, time: { created: 1 }, finish: undefined } },
    } as Event, { order })

    expect(changed).toBe(false)
    expect(draft.message.ses_1[0]).toBe(completed)
  })

  test("removes prior UI and sequence state when a part becomes filtered", () => {
    const order = createMessageOrderState()
    const existing = { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "visible" } as Part
    order.part.set(existing.id, 1)
    const draft = state({ part: { msg_1: [existing] } })

    const result = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { ...existing, type: "patch" },
      },
    } as Event, { order })

    expect(result).toBe(true)
    expect(draft.part.msg_1).toBe(undefined)
    expect(order.part.has(existing.id)).toBe(false)
    expect(order.partRevision.has(existing.id)).toBe(false)
    expect(order.partSession.has(existing.id)).toBe(false)
  })

  test("does not invalidate snapshots for an unseen filtered part", () => {
    const order = createMessageOrderState()
    const revision = order.revision

    expect(applyDirectoryEvent(state(), {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_hidden", messageID: "msg_1", sessionID: "ses_1", type: "step-start" },
      },
    } as Event, { order })).toBe(false)
    expect(order.revision).toBe(revision)
  })

  test("reorders a preserved final tool part when its sequence changes", () => {
    const order = createMessageOrderState()
    const final = {
      id: "prt_final",
      messageID: "msg_1",
      sessionID: "ses_1",
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: { status: "completed", input: {}, output: "done", title: "read", metadata: {}, time: { start: 1, end: 2 } },
    } as Part
    const other = { id: "prt_other", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "other" } as Part
    recordPartSequence(order, final.id, "ses_1", "msg_1", 1)
    recordPartSequence(order, other.id, "ses_1", "msg_1", 2)
    const draft = state({
      message: { ses_1: [{ id: "msg_1", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1 } } as Message] },
      part: { msg_1: [final, other] },
    })

    const changed = applyDirectoryEvent(draft, {
      seq: 3,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { ...final, state: { status: "running", input: {}, time: { start: 1 } } },
      },
    } as Event, { order })

    expect(changed).toBe(true)
    expect(draft.part.msg_1.map((item) => item.id)).toEqual(["prt_other", "prt_final"])
    expect((draft.part.msg_1[1] as { state?: { status?: string } }).state?.status).toBe("completed")
  })

  test("ignores a stale filtered update for a newer same-ID part", () => {
    const order = createMessageOrderState()
    const existing = { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "text", text: "new" } as Part
    order.part.set(existing.id, 2)
    const draft = state({ part: { msg_1: [existing] } })

    const result = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { ...existing, type: "patch" },
      },
    } as Event, { order })

    expect(result).toBe(false)
    expect(draft.part.msg_1).toEqual([existing])
    expect(order.part.get(existing.id)).toBe(2)
  })

  test("ignores stale lower-sequence entity updates", () => {
    const order = createMessageOrderState()
    order.message.set("msg_1", 10)
    const original = { id: "msg_1", sessionID: "ses_1", role: "user", agent: "live", time: { created: 1 } } as Message
    const draft = state({ message: { ses_1: [original] } })

    const changed = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.updated",
      properties: { info: { ...original, agent: "stale" } },
    } as Event, { order })

    expect(changed).toBe(false)
    expect((draft.message.ses_1[0] as { agent?: string }).agent).toBe("live")
  })

  test("rejects duplicate authoritative event sequences within a session", () => {
    const order = createMessageOrderState()
    recordMessageSequence(order, "msg_existing", "ses_1", 1)

    expect(() => applyDirectoryEvent(state(), {
      seq: 1,
      type: "message.updated",
      properties: { info: { id: "msg_new", sessionID: "ses_1", role: "user", time: { created: 1 } } },
    } as Event, { order })).toThrow("sequence 1 is already used")
  })

  test("rejects moving an existing part event to another message", () => {
    const order = createMessageOrderState()
    recordPartSequence(order, "prt_1", "ses_1", "msg_1", 1)

    expect(() => applyDirectoryEvent(state(), {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", messageID: "msg_2", sessionID: "ses_1", type: "text", text: "moved" },
      },
    } as Event, { order })).toThrow("already owned")
  })

  test("rejects stale lower-sequence updates with conflicting ownership", () => {
    const order = createMessageOrderState()
    recordMessageSequence(order, "msg_1", "ses_1", 10)
    recordPartSequence(order, "prt_1", "ses_1", "msg_1", 10)

    expect(() => applyDirectoryEvent(state(), {
      seq: 1,
      type: "message.updated",
      properties: { info: { id: "msg_1", sessionID: "ses_other", role: "user", time: { created: 1 } } },
    } as Event, { order })).toThrow("already owned")
    expect(() => applyDirectoryEvent(state(), {
      seq: 1,
      type: "message.part.updated",
      properties: {
        sessionID: "ses_1",
        part: { id: "prt_1", messageID: "msg_other", sessionID: "ses_1", type: "text", text: "stale" },
      },
    } as Event, { order })).toThrow("already owned")
  })

  test("rejects removal events whose ownership does not match", () => {
    const order = createMessageOrderState()
    recordMessageSequence(order, "msg_1", "ses_1", 1)
    recordPartSequence(order, "prt_1", "ses_1", "msg_1", 1)

    expect(() => applyDirectoryEvent(state(), {
      type: "message.removed",
      properties: { sessionID: "ses_other", messageID: "msg_1" },
    } as Event, { order })).toThrow("already owned")
    expect(() => applyDirectoryEvent(state(), {
      type: "message.part.removed",
      properties: { sessionID: "ses_1", messageID: "msg_other", partID: "prt_1" },
    } as Event, { order })).toThrow("already owned")
    expect(order.message.get("msg_1")).toBe(1)
    expect(order.part.get("prt_1")).toBe(1)
  })

  test("unseen removal events invalidate only their session snapshots", () => {
    const order = createMessageOrderState()
    const revision = beginMessageSnapshot(order, "ses_1")
    const otherRevision = beginMessageSnapshot(order, "ses_other")

    expect(applyDirectoryEvent(state(), {
      type: "message.removed",
      properties: { sessionID: "ses_1", messageID: "msg_missing" },
    } as Event, { order })).toBe(false)
    expect(applyDirectoryEvent(state(), {
      type: "message.part.removed",
      properties: { sessionID: "ses_1", messageID: "msg_1", partID: "prt_missing" },
    } as Event, { order })).toBe(false)
    expect(() => assertCurrentMessageSnapshot(order, "ses_1", revision)).toThrow("invalidated")
    assertCurrentMessageSnapshot(order, "ses_other", otherRevision)
  })

  test("replaces an optimistic message when its authoritative sequence arrives", () => {
    const order = createMessageOrderState()
    const optimistic = { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1 }, agent: "optimistic" } as Message
    const authoritative = { ...optimistic, agent: "server" } as Message
    const draft = state({ message: { ses_1: [optimistic] } })

    const changed = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.updated",
      properties: { info: authoritative },
    } as Event, { order })

    expect(changed).toBe(true)
    expect(draft.message.ses_1[0]).toBe(authoritative)
    expect(order.message.get("msg_1")).toBe(1)
  })

  test("moves a confirmed message ahead of still-optimistic messages", () => {
    const order = createMessageOrderState()
    const pending = { id: "msg_pending", sessionID: "ses_1", role: "user", time: { created: 1 } } as Message
    const confirming = { id: "msg_confirming", sessionID: "ses_1", role: "user", time: { created: 2 } } as Message
    order.messageSession.set(pending.id, "ses_1")
    order.messageSession.set(confirming.id, "ses_1")
    const draft = state({ message: { ses_1: [pending, confirming] } })

    const changed = applyDirectoryEvent(draft, {
      seq: 1,
      type: "message.updated",
      properties: { info: confirming },
    } as Event, { order })

    expect(changed).toBe(true)
    expect(draft.message.ses_1.map((item) => item.id)).toEqual(["msg_confirming", "msg_pending"])
  })

  test("skips duplicate session status events", () => {
    const draft = state()
    const busyStatus = { type: "busy" } as SessionStatus
    const event = {
      type: "session.status",
      properties: { sessionID: "ses_1", status: busyStatus },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session idle events", () => {
    const draft = state()
    const event = {
      type: "session.idle",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("skips duplicate session error idle-state events", () => {
    const draft = state()
    const event = {
      type: "session.error",
      properties: { sessionID: "ses_1" },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    const statusRef = draft.session_status.ses_1

    expect(applyDirectoryEvent(draft, event)).toBe(false)
    expect(draft.session_status.ses_1).toBe(statusRef)
  })

  test("detects retry status metadata changes", () => {
    const draft = state({
      session_status: {
        ses_1: { type: "retry", attempt: 1, message: "rate limited", next: 10 } as SessionStatus,
      },
    })

    const event = {
      type: "session.status",
      properties: {
        sessionID: "ses_1",
        status: { type: "retry", attempt: 2, message: "rate limited", next: 20 } as SessionStatus,
      },
    } as Event

    expect(applyDirectoryEvent(draft, event)).toBe(true)
    expect((draft.session_status.ses_1 as Extract<SessionStatus, { type: "retry" }>).attempt).toBe(2)
  })

  test("updates permission request arrays immutably", () => {
    const initialPermissions = [
      { id: "perm_1", sessionID: "ses_1" } as PermissionRequest,
    ]
    const draft = state({ permission: { ses_1: initialPermissions } })

    applyDirectoryEvent(draft, {
      type: "permission.asked",
      properties: { id: "perm_2", sessionID: "ses_1" } as PermissionRequest,
    } as Event)

    expect(draft.permission.ses_1).not.toBe(initialPermissions)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_1", "perm_2"])

    const afterAsk = draft.permission.ses_1
    applyDirectoryEvent(draft, {
      type: "permission.replied",
      properties: { sessionID: "ses_1", requestID: "perm_1" },
    } as Event)

    expect(draft.permission.ses_1).not.toBe(afterAsk)
    expect(draft.permission.ses_1.map((item) => item.id)).toEqual(["perm_2"])
  })

  test("updates question request arrays immutably", () => {
    const initialQuestions = [
      { id: "ques_1", sessionID: "ses_1" } as QuestionRequest,
    ]
    const draft = state({ question: { ses_1: initialQuestions } })

    applyDirectoryEvent(draft, {
      type: "question.asked",
      properties: { id: "ques_2", sessionID: "ses_1" } as QuestionRequest,
    } as Event)

    expect(draft.question.ses_1).not.toBe(initialQuestions)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_1", "ques_2"])

    const afterAsk = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.replied",
      properties: { sessionID: "ses_1", requestID: "ques_1" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterAsk)
    expect(draft.question.ses_1.map((item) => item.id)).toEqual(["ques_2"])

    const afterReply = draft.question.ses_1
    applyDirectoryEvent(draft, {
      type: "question.rejected",
      properties: { sessionID: "ses_1", requestID: "ques_2" },
    } as Event)

    expect(draft.question.ses_1).not.toBe(afterReply)
    expect(draft.question.ses_1).toEqual([])
  })
})
