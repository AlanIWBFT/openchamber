import type {
  Event,
  Message,
  Part,
  PermissionRequest,
  Project,
  QuestionRequest,
  Session,
  SessionStatus,
  Todo,
} from "@opencode-ai/sdk/v2/client"
import { Binary } from "./binary"
import type { FileDiff, GlobalState, State } from "./types"
import { dropSessionCaches } from "./session-cache"
import { stripSessionDiffSnapshots } from "./sanitize"
import { syncDebug } from "./debug"
import { shouldSkipStaleSessionEvent } from "./session-event-freshness"
import {
  dropMessageOrder,
  dropPartOrder,
  dropSessionOrder,
  invalidateSessionOrder,
  compareOrdered,
  recordMessageSequence,
  recordPartSequence,
  requireEventSequence,
  SequenceProtocolError,
  touchMessageOrder,
  touchPartOrder,
  upsertOrdered,
  type MessageOrderState,
} from "./message-order"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
const DELTA_OVERLAP_FIELDS = ["text", "output"] as const
const FINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "failed", "timeout", "cancelled"])

type DedupeMetadata = {
  __dedupeNextDeltaFields?: string[]
}

function appendNonOverlappingDelta(existingValue: string | undefined, delta: string) {
  if (!existingValue || delta.length === 0) return (existingValue ?? "") + delta
  if (existingValue.endsWith(delta)) return existingValue

  const maxOverlap = Math.min(existingValue.length, delta.length)
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    if (existingValue.endsWith(delta.slice(0, overlap))) {
      return existingValue + delta.slice(overlap)
    }
  }

  return existingValue + delta
}

function getUpdatedDeltaFields(previous: Part, next: Part) {
  const dedupeFields: string[] = []
  for (const field of DELTA_OVERLAP_FIELDS) {
    const previousValue = (previous as Record<string, unknown>)[field]
    const nextValue = (next as Record<string, unknown>)[field]
    if (typeof previousValue !== "string" || typeof nextValue !== "string") continue
    if (previousValue.length === 0 || nextValue.length === 0) continue
    if (nextValue === previousValue || nextValue.startsWith(previousValue) || previousValue.startsWith(nextValue)) {
      dedupeFields.push(field)
    }
  }
  return dedupeFields
}

function preserveLongerDeltaFields(previous: Part, next: Part, fields: readonly string[]): Part {
  let merged = next
  for (const field of fields) {
    const previousValue = (previous as Record<string, unknown>)[field]
    const nextValue = (next as Record<string, unknown>)[field]
    if (typeof previousValue !== "string" || typeof nextValue !== "string") continue
    if (previousValue.length <= nextValue.length || !previousValue.startsWith(nextValue)) continue
    if (merged === next) merged = { ...next }
    const mergedRecord = merged as Record<string, unknown>
    mergedRecord[field] = previousValue
  }
  return merged
}

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end
  if (typeof stateEnd === "number") {
    return stateEnd
  }

  const timeEnd = (part as { time?: { end?: unknown } }).time?.end
  return typeof timeEnd === "number" ? timeEnd : undefined
}

function getToolStatus(part: Part): string | undefined {
  if (part.type !== "tool") {
    return undefined
  }

  const status = (part as { state?: { status?: unknown } }).state?.status
  return typeof status === "string" ? status : undefined
}

function shouldPreserveExistingPart(previous: Part, next: Part): boolean {
  if (previous.type !== "tool" || next.type !== "tool") {
    return false
  }

  const previousStatus = getToolStatus(previous)
  const nextStatus = getToolStatus(next)
  if (previousStatus && FINAL_TOOL_STATUSES.has(previousStatus) && (!nextStatus || !FINAL_TOOL_STATUSES.has(nextStatus))) {
    return true
  }

  const previousEnd = getPartEndTime(previous)
  const nextEnd = getPartEndTime(next)
  if (typeof previousEnd === "number" && typeof nextEnd !== "number") {
    return true
  }

  return false
}

function areSessionStatusesEqual(left: SessionStatus | undefined, right: SessionStatus): boolean {
  if (left === right) return true
  if (!left || left.type !== right.type) return false
  if (left.type === "retry") {
    return right.type === "retry"
      && left.attempt === right.attempt
      && left.message === right.message
      && left.next === right.next
  }
  return true
}

function areJsonEquivalent(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return left === right
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function areMessageUpdateFieldsEqual(existing: Message, next: Message): boolean {
  if (existing.role !== next.role) return false
  if ((existing as { finish?: unknown }).finish !== (next as { finish?: unknown }).finish) return false
  if ((existing.time as { completed?: number })?.completed !== (next.time as { completed?: number })?.completed) return false

  const fields: Array<keyof Message | "structured" | "summary" | "tokens" | "error" | "cost" | "model" | "tools" | "format" | "variant" | "agent" | "system"> = [
    "summary",
    "error",
    "cost",
    "tokens",
    "structured",
    "model",
    "tools",
    "format",
    "variant",
    "agent",
    "system",
  ]

  for (const field of fields) {
    if (!areJsonEquivalent((existing as Record<string, unknown>)[field], (next as Record<string, unknown>)[field])) {
      return false
    }
  }

  return true
}

function shouldPreserveCompletedMessage(existing: Message, next: Message): boolean {
  const existingCompleted = (existing.time as { completed?: unknown }).completed
  const nextCompleted = (next.time as { completed?: unknown }).completed
  return existing.role === "assistant"
    && next.role === "assistant"
    && typeof existingCompleted === "number"
    && existingCompleted > 0
    && typeof nextCompleted !== "number"
}

// ---------------------------------------------------------------------------
// Global events
// ---------------------------------------------------------------------------

export type GlobalEventResult = {
  type: "refresh"
} | {
  type: "project"
  project: Project
} | null

export type SessionMaterializationReason =
  | "missing-owning-message"
  | "orphan-delta"
  | "missing-delta-part"
  | "empty-assistant-message"
  | "child-session-idle"
  | "child-session-discovered"
  | "ensure-session-messages"
  | "stream-reconnect"
  | "transport-switch"
  | "stale-status-resync"
  | "settled-running-tool"
  | "sequence-protocol-mismatch"

export type DirectoryEventResult = boolean | {
  changed: boolean
  materialization: {
    type: "incomplete-session-snapshot"
    reason: SessionMaterializationReason
    sessionID?: string
    messageID: string
    partID?: string
  }
}

function hasMessage(draft: State, sessionID: string | undefined, messageID: string): boolean {
  if (!sessionID) return false
  const messages = draft.message[sessionID]
  if (!messages) return false
  return messages.some((message) => message.id === messageID)
}

export function reduceGlobalEvent(event: Event): GlobalEventResult {
  if (event.type === "global.disposed" || event.type === "server.connected") {
    return { type: "refresh" }
  }
  if (event.type === "project.updated") {
    return { type: "project", project: event.properties as Project }
  }
  return null
}

export function applyGlobalProject(state: GlobalState, project: Project): GlobalState {
  const projects = [...state.projects]
  const result = Binary.search(projects, project.id, (s) => s.id)
  if (result.found) {
    projects[result.index] = { ...projects[result.index], ...project }
  } else {
    projects.splice(result.index, 0, project)
  }
  return { ...state, projects }
}

// ---------------------------------------------------------------------------
// Directory events — mutates draft in place for batching efficiency.
// Caller MUST pass a mutable copy of State (e.g. structuredClone or spread).
// ---------------------------------------------------------------------------

export function applyDirectoryEvent(
  draft: State,
  event: Event,
  callbacks?: {
    onRefresh?: (directory: string) => void
    onLoadLsp?: () => void
    onSetSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void
    order?: MessageOrderState
  },
): DirectoryEventResult {
  const markSessionEvent = (sessionID: string, deleted: boolean) => {
    const revision = (draft.sessionRevision ?? 0) + 1
    draft.sessionRevision = revision
    draft.sessionListSource = "live"
    draft.sessionEventRevision = draft.sessionEventRevision ?? {}
    draft.sessionDeletedRevision = draft.sessionDeletedRevision ?? {}
    if (deleted) {
      draft.sessionDeletedRevision[sessionID] = revision
      delete draft.sessionEventRevision[sessionID]
    } else {
      draft.sessionEventRevision[sessionID] = revision
      delete draft.sessionDeletedRevision[sessionID]
    }
  }

  switch (event.type) {
    case "server.instance.disposed": {
      callbacks?.onRefresh?.("")
      return false
    }

    case "session.created": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      if (result.found && shouldSkipStaleSessionEvent(sessions[result.index], info)) {
        return false
      }
      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
        if (!info.parentID) draft.sessionTotal += 1
      }
      markSessionEvent(info.id, false)
      return true
    }

    case "session.updated": {
      const info = stripSessionDiffSnapshots((event.properties as { info: Session }).info)
      const sessions = draft.session
      const result = Binary.search(sessions, info.id, (s) => s.id)
      // Keep the freshness check ahead of the archive branch: direct archive
      // responses handle the store update on their own (optimistic removal +
      // SDK response), so stale SSE echoes should not win just because they
      // mark the session archived.
      if (result.found && shouldSkipStaleSessionEvent(sessions[result.index], info)) {
        return false
      }

      if (info.time.archived) {
        if (result.found) sessions.splice(result.index, 1)
        cleanupSessionCaches(draft, info.id, callbacks?.onSetSessionTodo, callbacks?.order)
        if (!info.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
        markSessionEvent(info.id, true)
        return true
      }

      if (result.found) {
        sessions[result.index] = info
      } else {
        sessions.splice(result.index, 0, info)
        trimSessions(draft)
      }
      markSessionEvent(info.id, false)
      return true
    }

    case "session.deleted": {
      const sessions = draft.session
      const props = event.properties as { info?: Session; sessionID?: string }
      const sessionID = props.info?.id ?? props.sessionID
      if (!sessionID) return false
      const result = Binary.search(sessions, sessionID, (s) => s.id)
      const info = props.info ?? (result.found ? sessions[result.index] : undefined)
      if (result.found) sessions.splice(result.index, 1)
      if (!info?.parentID) draft.sessionTotal = Math.max(0, draft.sessionTotal - 1)
      markSessionEvent(sessionID, true)
      cleanupSessionCaches(draft, sessionID, callbacks?.onSetSessionTodo, callbacks?.order)
      return true
    }

    case "session.diff": {
      const props = event.properties as { sessionID: string; diff: FileDiff[] }
      draft.session_diff[props.sessionID] = props.diff
      return true
    }

    case "todo.updated": {
      const props = event.properties as { sessionID: string; todos: Todo[] }
      if (areJsonEquivalent(draft.todo[props.sessionID], props.todos)) {
        return false
      }
      draft.todo[props.sessionID] = props.todos
      callbacks?.onSetSessionTodo?.(props.sessionID, props.todos)
      return true
    }

    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], props.status)) {
        return false
      }
      draft.session_status[props.sessionID] = props.status
      return true
    }

    case "session.idle": {
      const props = event.properties as { sessionID: string }
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "session.error": {
      const props = event.properties as { sessionID: string }
      const status = { type: "idle" } as const
      if (areSessionStatusesEqual(draft.session_status[props.sessionID], status)) {
        return false
      }
      draft.session_status[props.sessionID] = status
      return true
    }

    case "message.updated": {
      const info = (event.properties as { info: Message }).info
      const order = callbacks?.order
      if (!order) throw new Error("Message order state is required")
      if (!info || typeof info.id !== "string" || info.id.length === 0) {
        throw new SequenceProtocolError("Message identity is missing or invalid")
      }
      if (typeof info.sessionID !== "string" || info.sessionID.length === 0) {
        throw new SequenceProtocolError(`Message ${info.id} session identity is missing or invalid`)
      }
      const owner = order.messageSession.get(info.id)
      if (owner && owner !== info.sessionID) {
        throw new SequenceProtocolError(`Message ${info.id} belongs to Session ${info.sessionID}, already owned by ${owner}`)
      }
      const seq = requireEventSequence(event, `Message ${info.id}`)
      const previousSeq = order.message.get(info.id)
      if (previousSeq !== undefined && seq < previousSeq) return false
      recordMessageSequence(order, info.id, info.sessionID, seq)
      touchMessageOrder(order, info.id)
      const messages = draft.message[info.sessionID]
      if (!messages) {
        draft.message[info.sessionID] = [info]
        return true
      }
      const index = messages.findIndex((message) => message.id === info.id)
      if (index >= 0) {
        // Skip message replacement if unchanged — preserves reference, avoids re-render
        const existing = messages[index]
        if (shouldPreserveCompletedMessage(existing, info)) {
          const reordered = upsertOrdered(messages, existing, order.message)
          const changed = reordered.some((candidate, candidateIndex) => candidate !== messages[candidateIndex])
          if (changed) draft.message[info.sessionID] = reordered
          return changed
        }
        const unchanged = previousSeq !== undefined && areMessageUpdateFieldsEqual(existing, info)
        const reordered = index > 0 && compareOrdered(messages[index - 1].id, info.id, order.message) > 0
          || index + 1 < messages.length && compareOrdered(info.id, messages[index + 1].id, order.message) > 0
        if (unchanged && !reordered) {
          syncDebug.reducer.messageUpdatedUnchanged(info.sessionID, info.id, info.role, (info as { finish?: unknown }).finish, (info.time as { completed?: number })?.completed)
          return false
        }
        draft.message[info.sessionID] = upsertOrdered(messages, info, order.message)
      } else {
        draft.message[info.sessionID] = upsertOrdered(messages, info, order.message)
      }
      return true
    }

    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      const order = callbacks?.order
      const owner = order?.messageSession.get(props.messageID)
      if (owner && owner !== props.sessionID) {
        throw new SequenceProtocolError(`Message ${props.messageID} belongs to Session ${props.sessionID}, already owned by ${owner}`)
      }
      const removedParts = draft.part[props.messageID]
      const messages = draft.message[props.sessionID]
      let removed = false
      if (messages) {
        const next = [...messages]
        const index = next.findIndex((message) => message.id === props.messageID)
        if (index >= 0) {
          next.splice(index, 1)
          draft.message[props.sessionID] = next
          removed = true
        }
      }
      const hasOwnedPart = order ? [...order.partMessage.values()].some((messageID) => messageID === props.messageID) : false
      const hasOrder = Boolean(order && (
        order.message.has(props.messageID)
        || order.messageSession.has(props.messageID)
        || order.messageRevision.has(props.messageID)
      )) || hasOwnedPart
      if (!removed && removedParts === undefined && !hasOrder) {
        if (order) invalidateSessionOrder(order, props.sessionID)
        return false
      }
      if (order) dropMessageOrder(order, props.messageID, removedParts)
      delete draft.part[props.messageID]
      return removed || removedParts !== undefined || hasOrder
    }

    case "message.part.updated": {
      const props = event.properties as { sessionID?: unknown; part: Part }
      const part = props.part
      const order = callbacks?.order
      if (!order) throw new Error("Message order state is required")
      if (!part || typeof part.id !== "string" || part.id.length === 0) {
        throw new SequenceProtocolError("Part identity is missing or invalid")
      }
      const topLevelSessionID = props.sessionID
      if (topLevelSessionID !== undefined && (typeof topLevelSessionID !== "string" || topLevelSessionID.length === 0)) {
        throw new SequenceProtocolError(`Part ${part.id} session identity is missing or invalid`)
      }
      const partSessionID = (part as { sessionID?: unknown }).sessionID
      if (partSessionID !== undefined && (typeof partSessionID !== "string" || partSessionID.length === 0)) {
        throw new SequenceProtocolError(`Part ${part.id} session identity is missing or invalid`)
      }
      if (topLevelSessionID && partSessionID && topLevelSessionID !== partSessionID) {
        throw new SequenceProtocolError(`Part ${part.id} has conflicting Session identities`)
      }
      const sessionID = topLevelSessionID ?? partSessionID
      const messageID = (part as { messageID?: unknown }).messageID
      if (typeof messageID !== "string" || messageID.length === 0) {
        throw new SequenceProtocolError(`Part ${part.id} message identity is missing or invalid`)
      }
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        throw new SequenceProtocolError(`Part ${part.id} session identity is missing or invalid`)
      }
      const ownedMessageID = order.partMessage.get(part.id)
      const ownedSessionID = order.partSession.get(part.id)
      if (ownedMessageID && ownedMessageID !== messageID) {
        throw new SequenceProtocolError(`Part ${part.id} belongs to Message ${messageID}, already owned by ${ownedMessageID}`)
      }
      if (ownedSessionID && ownedSessionID !== sessionID) {
        throw new SequenceProtocolError(`Part ${part.id} belongs to Session ${sessionID}, already owned by ${ownedSessionID}`)
      }
      const seq = requireEventSequence(event, `Part ${part.id}`)
      const previousSeq = order.part.get(part.id)
      if (previousSeq !== undefined && seq < previousSeq) return false
      if (SKIP_PARTS.has(part.type)) {
        syncDebug.reducer.partSkipped(messageID, part.id, part.type)
        const current = draft.part[messageID]
        const hasPart = current?.some((candidate) => candidate.id === part.id) ?? false
        if (hasPart || order.part.has(part.id) || order.partSession.has(part.id) || order.partMessage.has(part.id)) {
          dropPartOrder(order, part.id)
        }
        if (!current) return false
        const next = current.filter((candidate) => candidate.id !== part.id)
        if (next.length === current.length) return false
        if (next.length === 0) delete draft.part[messageID]
        else draft.part[messageID] = next
        return true
      }
      recordPartSequence(order, part.id, sessionID, messageID, seq)
      touchPartOrder(order, part.id)
      const missingOwningMessage = !hasMessage(draft, sessionID, messageID)
      const parts = draft.part[messageID]
      if (!parts) {
        syncDebug.reducer.partUpdatedNoExistingParts(messageID, part.id, part.type)
        draft.part[messageID] = [part]
        return missingOwningMessage
          ? {
            changed: true,
            materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
          }
          : true
      }
      const next = [...parts]
      const index = next.findIndex((candidate) => candidate.id === part.id)
      if (index >= 0) {
        const previous = next[index]
        if (shouldPreserveExistingPart(previous, part)) {
          const reordered = upsertOrdered(next, previous, order.part)
          const changed = reordered.some((candidate, candidateIndex) => candidate !== next[candidateIndex])
          if (changed) draft.part[messageID] = reordered
          return missingOwningMessage
            ? {
              changed,
              materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
            }
            : changed
        }
        const dedupeFields = getUpdatedDeltaFields(previous, part)
        const mergedPart = preserveLongerDeltaFields(previous, part, dedupeFields)
        const updated = dedupeFields.length > 0
          ? { ...mergedPart, __dedupeNextDeltaFields: dedupeFields } as unknown as Part
          : mergedPart
        draft.part[messageID] = upsertOrdered(next, updated, order.part)
      } else {
        // Optimistic parts are the only parts without authoritative sequence.
        const optimisticIdx = part.type === "text" || part.type === "file"
          ? next.findIndex((candidate) => candidate.type === part.type && !order.part.has(candidate.id))
          : -1
        if (optimisticIdx >= 0) {
          const optimisticPart = next[optimisticIdx]
          if (optimisticPart) dropPartOrder(order, optimisticPart.id)
          // Replace before sorting so the common optimistic case does not
          // transiently append and remount at the end of the message.
          next[optimisticIdx] = part
        }
        draft.part[messageID] = upsertOrdered(next, part, order.part)
      }
      return missingOwningMessage
        ? {
          changed: true,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-owning-message", sessionID, messageID, partID: part.id },
        }
        : true
    }

    case "message.part.removed": {
      const props = event.properties as { sessionID?: string; messageID: string; partID: string }
      const order = callbacks?.order
      const ownerMessage = order?.partMessage.get(props.partID)
      const ownerSession = order?.partSession.get(props.partID)
      if (ownerMessage && ownerMessage !== props.messageID) {
        throw new SequenceProtocolError(`Part ${props.partID} belongs to Message ${props.messageID}, already owned by ${ownerMessage}`)
      }
      if (props.sessionID && ownerSession && ownerSession !== props.sessionID) {
        throw new SequenceProtocolError(`Part ${props.partID} belongs to Session ${props.sessionID}, already owned by ${ownerSession}`)
      }
      const parts = draft.part[props.messageID]
      const index = parts?.findIndex((part) => part.id === props.partID) ?? -1
      const hasOrder = Boolean(order && (
        order.part.has(props.partID)
        || order.partSession.has(props.partID)
        || order.partMessage.has(props.partID)
        || order.partRevision.has(props.partID)
      ))
      if (index < 0 && !hasOrder) {
        if (order && props.sessionID) invalidateSessionOrder(order, props.sessionID)
        return false
      }
      if (order) dropPartOrder(order, props.partID)
      if (index >= 0) {
        const next = [...parts!]
        next.splice(index, 1)
        if (next.length === 0) {
          delete draft.part[props.messageID]
        } else {
          draft.part[props.messageID] = next
        }
        return true
      }
      return false
    }

    case "message.part.delta": {
      const props = event.properties as {
        sessionID?: string
        messageID: string
        partID: string
        field: string
        delta: string
      }
      const order = callbacks?.order
      const ownerMessage = order?.partMessage.get(props.partID)
      const ownerSession = order?.partSession.get(props.partID)
      if (ownerMessage && ownerMessage !== props.messageID) {
        throw new SequenceProtocolError(`Part ${props.partID} belongs to Message ${props.messageID}, already owned by ${ownerMessage}`)
      }
      if (props.sessionID && ownerSession && ownerSession !== props.sessionID) {
        throw new SequenceProtocolError(`Part ${props.partID} belongs to Session ${props.sessionID}, already owned by ${ownerSession}`)
      }
      const parts = draft.part[props.messageID]
      if (!parts) {
        syncDebug.reducer.partDeltaNoParts(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "orphan-delta", sessionID: props.sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      const index = parts.findIndex((part) => part.id === props.partID)
      if (index < 0) {
        syncDebug.reducer.partDeltaNotFound(props.messageID, props.partID)
        return {
          changed: false,
          materialization: { type: "incomplete-session-snapshot", reason: "missing-delta-part", sessionID: props.sessionID, messageID: props.messageID, partID: props.partID },
        }
      }
      if (order) touchPartOrder(order, props.partID)
      const existing = parts[index] as Record<string, unknown>
      const existingValue = existing[props.field] as string | undefined
      const dedupeFields = (existing as DedupeMetadata).__dedupeNextDeltaFields ?? []
      const shouldDedupe = dedupeFields.includes(props.field)
      // Create new Part object + new array so React detects the change
      const next = [...parts]
      next[index] = {
        ...existing,
        [props.field]: shouldDedupe ? appendNonOverlappingDelta(existingValue, props.delta) : (existingValue ?? "") + props.delta,
        __dedupeNextDeltaFields: dedupeFields.filter((field) => field !== props.field),
      } as unknown as Part
      draft.part[props.messageID] = next
      return true
    }

    case "vcs.branch.updated": {
      const props = event.properties as { branch: string }
      if (draft.vcs?.branch === props.branch) return false
      draft.vcs = { branch: props.branch }
      return true
    }

    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      const permissions = draft.permission[permission.sessionID] ?? []
      const next = [...permissions]
      const result = Binary.search(next, permission.id, (p) => p.id)
      if (result.found) {
        next[result.index] = permission
      } else {
        next.splice(result.index, 0, permission)
      }
      draft.permission[permission.sessionID] = next
      return true
    }

    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      const permissions = draft.permission[props.sessionID]
      if (!permissions) return false
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (result.found) {
        const next = [...permissions]
        next.splice(result.index, 1)
        draft.permission[props.sessionID] = next
        return true
      }
      return false
    }

    case "question.asked": {
      const question = event.properties as QuestionRequest
      const questions = draft.question[question.sessionID] ?? []
      const next = [...questions]
      const result = Binary.search(next, question.id, (q) => q.id)
      if (result.found) {
        next[result.index] = question
      } else {
        next.splice(result.index, 0, question)
      }
      draft.question[question.sessionID] = next
      return true
    }

    case "question.replied":
    case "question.rejected": {
      const props = event.properties as { sessionID: string; requestID: string }
      const questions = draft.question[props.sessionID]
      if (!questions) return false
      const result = Binary.search(questions, props.requestID, (q) => q.id)
      if (result.found) {
        const next = [...questions]
        next.splice(result.index, 1)
        draft.question[props.sessionID] = next
        return true
      }
      return false
    }

    case "lsp.updated": {
      callbacks?.onLoadLsp?.()
      return false
    }

    default:
      return false
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSessions(draft: State) {
  if (draft.session.length <= draft.limit) return
  // Keep sessions that have pending permissions (they need to stay visible)
  const hasPermission = new Set(
    Object.entries(draft.permission ?? {})
      .filter(([, perms]) => perms && perms.length > 0)
      .map(([sessionID]) => sessionID),
  )
  while (draft.session.length > draft.limit) {
    // Remove from the beginning (oldest by sorted ID)
    const candidate = draft.session[0]
    if (hasPermission.has(candidate.id)) break
    draft.session.shift()
  }
}

function cleanupSessionCaches(
  draft: State,
  sessionID: string,
  setSessionTodo?: (sessionID: string, todos: Todo[] | undefined) => void,
  order?: MessageOrderState,
) {
  if (!sessionID) return
  setSessionTodo?.(sessionID, undefined)
  if (order) dropSessionOrder(order, sessionID, draft.message[sessionID], draft.part)
  dropSessionCaches(draft, [sessionID])
}
