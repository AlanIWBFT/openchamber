
import type { FilePart, FormRequest, JsonValue, Message, Metadata, ModelSelection, Part, PermissionRequest, Session, SyntheticMessage, TextPart, UserMessage } from "@/lib/opencode/model"
import type { FormValue } from "@opencode/client"
import { compact, partIds } from "@/lib/opencode/model"
import { attachmentBasename, withMissingCitations } from "@/lib/attachmentIdentity"
import { isAutoModel } from "@/lib/routing/autoModel"
import { Binary } from "./binary"
import { dropSessionCaches } from "./session-cache"
import { forkAtTranscriptCut, isTurnBoundary, transcriptCutAfterMessage, transcriptCutForMessage } from "./transcript-cut"
import { isRunningSubagentRunMessage, readSubagentRun } from "@/lib/opencode/subagent-run"
import { useSessionUIStore, type SentMessage } from "./session-ui-store"
import { useSelectionStore } from "./selection-store"
import {
  DEFERRED_ANSWER_LEAD_IN,
  DEFERRED_QUESTION_NOTE,
  deferredAnswerMetadata,
  formReleaseKey,
  formToolLink,
  formTurnHold,
  isWaitingQuestionCall,
  noteFormToolReleased,
  noteLocalFormCancelled,
  noteLocalFormReplied,
  submitRecoveredAnswer,
  useRecoverableQuestionsStore,
  recoveredQuestionAnswerMetadata,
  type RecoveredQuestion,
} from "./recoverable-questions"
import { resolveCheckedSendSelection, resolveSendSelection } from "./session-selection"
import { useInputStore } from "./input-store"
import type { ChildStoreManager } from "./child-store"
import { computeSubtreeIds } from "./scoped-blocking-requests"
import { withUserWorkTitle } from "@/lib/sessionWorkTitle"
import { opencodeClient, type MessagePage, type SyntheticContextInput } from "@/lib/opencode/client"
import { withSessionMetadata } from "@/lib/opencode/projection"
import { toJsonRecord } from "@/lib/opencode/json"
import { ascendingId } from "@/lib/opencode/ids"
import { mergeSessionDirectoryMetadata, resolveGlobalSessionDirectory, useGlobalSessionsStore } from "@/stores/useGlobalSessionsStore"
import { findWorktreeHoldingDirectory } from "@/lib/worktrees/worktreePaths"
import { createMessageQueueTarget, useMessageQueueStore } from "@/stores/messageQueueStore"
import { followSessionTabMove } from "@/lib/sessionTabs"
import { useSessionFoldersStore } from "@/stores/useSessionFoldersStore"
import { readGlobalSessionLineage } from "@/stores/sessionLineage"
import { isRestorableOnItsOwn } from "./session-restore-rule"
import { useConfigStore } from "@/stores/useConfigStore"
import { waitForOpenCodeStartup } from "./opencode-startup-gate"
import { getAllSyncSessionMap, getDirectoryState, registerSessionDirectory } from "./sync-refs"
import { useGlobalSessionStatusStore } from "./global-session-status"
import { recordSendFailure } from "./send-failure-log"
import { draftFromContextPayload, readContextPart, type ContextCarrierPart } from "@/lib/messages/contextParts"
import { useInlineCommentDraftStore, type InlineCommentDraftTarget } from "@/stores/useInlineCommentDraftStore"
import { materializeSessionSnapshots } from "./materialization"
import { beginMessageSnapshot, invalidateMessageSnapshots } from "./message-snapshot"
import { sessionEvents } from "@/lib/sessionEvents"
import { fileTreeChanges } from "@/lib/fileTreeChanges"
import {
  getOriginalSessionID,
  getSessionMetadata,
  isReviewSession,
  withoutReviewSessionLink,
  type SessionMetadataRecord,
} from "@/lib/sessionReviewMetadata"
import { withContextObligatoryMessage, type ContextObligatoryMessage } from "@/lib/contextObligatoryMessages"
import { getBtwOriginalSessionID, getBtwSessionID, isBtwSession, withoutBtwSessionLink } from "@/lib/sessionBtwMetadata"
import { type LinkedIssue } from "@/lib/linkedIssues"
import { withSessionWorkClosed, withSessionWorkState, type SessionWork } from "@/lib/sessionWorkMetadata"
import { isPinnedMetadata, withSessionPinned } from "@/lib/sessionPins"
import { getImperativeSessionMessageLoader, hasSessionMessageRequirement, type SessionMessageRequirement } from "./session-message-loader"
import { cleanupPersistedSessionState } from "./session-deletion-cleanup"
import { requestSessionArchiveBatch, requestSessionLinksUpdate, requestSessionMetadataUpdate, requestSessionUnarchiveBatch, type SessionArchiveStamp } from "./session-archive-batch"
import { registerBulkArchiveEchoes, releaseBulkArchiveEchoes } from "./bulk-archive-echo"
import { markSessionUnreadSeen } from "./session-unread"
import { captureRuntimeInstance, getRuntimeKey } from "@/lib/runtime-switch"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { readSpaceArchiveChatState } from "@/lib/spaces/spaces-api"
import { isRelayModeActive } from "@/lib/relay/runtime-tunnel"
import { isVSCodeRuntime } from "@/lib/desktop"
import { getErrorStatus, isAmbiguousSendFailure } from "./send-failure-classification"
import { isFormAlreadySettledError, isFormRequestNotFoundError } from "./form-request-error"
import { ConnectionLostError } from "./connection-lost-error"
import { getStaleRunningToolMessageID } from "./materialization"
import { promoteRestoredSessionOrdering } from "./session-ordering"
import { normalizePath } from "@/lib/pathNormalization"
import { mergeMessages } from "./optimistic"
import { trackPromptInFlight } from "./prompts-in-flight"
import { createChatDraftIdentity, type ChatDraftIdentity } from "@/lib/chatDraftPersistence"
import { LOCATION_SCOPED_FORM_SESSION_ID } from "./location-scoped-forms"
import { cancelSessionTitleGeneration } from "./session-title-generation"
import { recordSessionActionFailure } from "./session-action-failures"
import { beginSessionStatusRequest, readDirectoryStatusSnapshot } from "./directory-recovery-snapshots"
import { applyForkInheritance } from "@/lib/sessionForkInheritance"
import { getSessionGoal } from "@/lib/sessionGoalMetadata"
import { fetchGoalObjectiveContent, writeGoalObjectiveFile } from "@/lib/goalObjectiveFiles"
import { selectRevertedMessages } from "./message-boundary"

const SEND_CONFIRMATION_REFETCH_LIMIT = 30
const MESSAGE_REFETCH_LIMIT = 100
const SEND_CONFIRMATION_REFETCH_ATTEMPTS = 3
const SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS = 250
const SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS = 3000
const SEND_CONFIRMATION_RECONNECT_POLL_MS = 100
let _childStores: ChildStoreManager | null = null
let _getDirectory: () => string = () => ""
let _enqueueSessionMaterialization: ((directory: string, sessionID: string, messageID: string) => void) | null = null
type OptimisticAddInput = { sessionID: string; directory?: string | null; message: Message; parts: Part[] }
type OptimisticRemoveInput = { sessionID: string; directory?: string | null; messageID: string }
type OptimisticConfirmInput = OptimisticRemoveInput

let _optimisticAdd: ((input: OptimisticAddInput) => void) | null = null
let _optimisticRemove: ((input: OptimisticRemoveInput) => void) | null = null
let _optimisticConfirm: ((input: OptimisticConfirmInput) => void) | null = null

function sessionsMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionIds: Iterable<string>,
  deleted: boolean,
) {
  const revision = (state.sessionRevision ?? 0) + 1
  const sessionEventRevision = { ...(state.sessionEventRevision ?? {}) }
  const sessionDeletedRevision = { ...(state.sessionDeletedRevision ?? {}) }
  for (const sessionId of sessionIds) {
    if (deleted) {
      sessionDeletedRevision[sessionId] = revision
      delete sessionEventRevision[sessionId]
    } else {
      sessionEventRevision[sessionId] = revision
      delete sessionDeletedRevision[sessionId]
    }
  }
  return {
    sessionListSource: "live" as const,
    sessionRevision: revision,
    sessionEventRevision,
    sessionDeletedRevision,
  }
}

function sessionMutationPatch(
  state: ReturnType<DirectoryStoreApi["getState"]>,
  sessionId: string,
  deleted: boolean,
) {
  return sessionsMutationPatch(state, [sessionId], deleted)
}

function invalidateSessionLoads(sessionId: string, directories: Iterable<string | null | undefined>): void {
  const loader = getImperativeSessionMessageLoader()
  if (!loader) return
  for (const directory of new Set(directories)) {
    if (directory) loader.invalidateSession({ directory, sessionID: sessionId })
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function setActionRefs(
  childStores: ChildStoreManager,
  getDirectory: () => string,
  enqueueSessionMaterialization?: (directory: string, sessionID: string, messageID: string) => void,
) {
  _childStores = childStores
  _getDirectory = getDirectory
  _enqueueSessionMaterialization = enqueueSessionMaterialization ?? null
}

export function setOptimisticRefs(
  add: (input: OptimisticAddInput) => void,
  remove: (input: OptimisticRemoveInput) => void,
  confirm?: (input: OptimisticConfirmInput) => void,
) {
  _optimisticAdd = add
  _optimisticRemove = remove
  _optimisticConfirm = confirm ?? null
}

function dirStore() {
  if (!_childStores) throw new Error("Child stores not initialized")
  const d = _getDirectory()
  if (!d) throw new Error("No current directory")
  return _childStores.ensureChild(d)
}

function dirStoreForDirectory(directory: string) {
  if (!_childStores) throw new Error("Child stores not initialized")
  if (!directory) throw new Error("No directory")
  return _childStores.ensureChild(directory)
}

function dirStoreForSession(sessionId: string): { store: DirectoryStoreApi; directory?: string } {
  const directory = getSessionDirectory(sessionId)
  if (directory) {
    return { store: dirStoreForDirectory(directory), directory }
  }
  return { store: dirStore(), directory: dir() }
}

export async function ensureSessionMessageRequirement(
  sessionId: string,
  requirement: SessionMessageRequirement,
): Promise<boolean> {
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  if (hasSessionMessageRequirement(store.getState().message[sessionId] ?? [], requirement)) return true
  const loader = getImperativeSessionMessageLoader()
  if (!loader || !directory) return false
  const found = await loader.loadUntil({ directory, sessionID: sessionId }, requirement)
  if (isStaleRuntime(expectedRuntimeKey) || _childStores?.getChild(directory) !== store) {
    throw new Error("Session history lookup was invalidated")
  }
  return found
}

export function getSessionLastAssistantModel(sessionId: string): { providerID: string; modelID: string } | null {
  try {
    const { store } = dirStoreForSession(sessionId)
    const messages = store.getState().message[sessionId]
    if (!messages) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const info = messages[i]
      if (info?.role === "assistant" && info.providerID && info.modelID) {
        return { providerID: info.providerID, modelID: info.modelID }
      }
    }
    return null
  } catch {
    return null
  }
}

function updateLiveSession(session: Session, directory?: string): boolean {
  const stores = _childStores
  if (!stores) return false

  const candidates = directory
    ? [[directory, stores.getChild(directory)] as const]
    : stores.children

  for (const [, store] of candidates) {
    if (!store) continue
    const current = store.getState().session
    const index = current.findIndex((item) => item.id === session.id)
    if (index === -1) continue

    const next = [...current]
    next[index] = mergeSessionDirectoryMetadata(session, current[index])
    store.setState({ session: next })
    return true
  }

  return false
}

function mirrorSessionIntoLiveStores(session: Session, directory?: string): void {
  if (directory && updateLiveSession(session, directory)) {
    return
  }
  updateLiveSession(session)
}

function moveRecordEntries<T>(
  source: Record<string, T>,
  destination: Record<string, T>,
  keys: Iterable<string>,
): { source: Record<string, T>; destination: Record<string, T> } {
  let nextSource = source
  let nextDestination = destination

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue
    if (nextSource === source) nextSource = { ...source }
    if (nextDestination === destination) nextDestination = { ...destination }
    nextDestination[key] = source[key]
    delete nextSource[key]
  }

  return { source: nextSource, destination: nextDestination }
}

function reconcileSessionMove(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
): Session {
  const stores = _childStores
  const sourceStore = stores?.getChild(sourceDirectory)
  const destinationStore = stores?.ensureChild(destinationDirectory, { bootstrap: false })
  const sourceState = sourceStore?.getState()
  const destinationState = destinationStore?.getState()
  if (sourceStore) invalidateMessageSnapshots(sourceStore, session.id)
  if (destinationStore) invalidateMessageSnapshots(destinationStore, session.id)
  const liveSession = sourceState?.session.find((candidate) => candidate.id === session.id)
  const adoptedSession = liveSession
    ? undefined
    : destinationState?.session.find((candidate) => candidate.id === session.id)
  const movedSession: Session = {
    ...(adoptedSession ?? mergeSessionDirectoryMetadata(session, liveSession)),
    directory: destinationDirectory,
  }

  if (!destinationStore || !destinationState || sourceStore === destinationStore) {
    return movedSession
  }

  const destinationSessionIndex = destinationState.session.findIndex((candidate) => candidate.id === session.id)
  const destinationSessions = [...destinationState.session]
  if (destinationSessionIndex === -1) destinationSessions.push(movedSession)
  else destinationSessions[destinationSessionIndex] = movedSession

  if (!sourceStore || !sourceState) {
    destinationStore.setState({
      session: destinationSessions,
      sessionTotal: destinationSessionIndex === -1
        ? destinationState.sessionTotal + 1
        : destinationState.sessionTotal,
    })
    return movedSession
  }

  const sourceContainsSession = sourceState.session.some((candidate) => candidate.id === session.id)
  const status = moveRecordEntries(sourceState.session_status, destinationState.session_status, [session.id])
  const permissions = moveRecordEntries(sourceState.permission, destinationState.permission, [session.id])
  const forms = moveRecordEntries(sourceState.form, destinationState.form, [session.id])
  const messages = moveRecordEntries(sourceState.message, destinationState.message, [session.id])
  const messageIds = sourceState.message[session.id]?.map((message) => message.id) ?? []
  const parts = moveRecordEntries(sourceState.part, destinationState.part, messageIds)

  sourceStore.setState({
    session: sourceState.session.filter((candidate) => candidate.id !== session.id),
    sessionTotal: sourceContainsSession ? Math.max(0, sourceState.sessionTotal - 1) : sourceState.sessionTotal,
    session_status: status.source,
    permission: permissions.source,
    form: forms.source,
    message: messages.source,
    part: parts.source,
    ...sessionMutationPatch(sourceState, session.id, true),
  })
  destinationStore.setState({
    session: destinationSessions,
    sessionTotal: destinationSessionIndex === -1
      ? destinationState.sessionTotal + 1
      : destinationState.sessionTotal,
    session_status: status.destination,
    permission: permissions.destination,
    form: forms.destination,
    message: messages.destination,
    part: parts.destination,
    ...sessionMutationPatch(destinationState, session.id, false),
  })

  return movedSession
}

export async function moveSessionToDirectory(
  session: Session,
  sourceDirectory: string,
  destinationDirectory: string,
  isCurrent?: () => boolean,
): Promise<void> {
  await opencodeClient.moveSession(session.id, destinationDirectory)

  if (isCurrent && !isCurrent()) return

  relocateSession(session, sourceDirectory, destinationDirectory)
}

export function adoptSessionMove(sessionId: string, sourceDirectory: string, destinationDirectory: string): void {
  const session = _childStores?.getChild(sourceDirectory)?.getState().session.find((candidate) => candidate.id === sessionId)
    ?? _childStores?.getChild(destinationDirectory)?.getState().session.find((candidate) => candidate.id === sessionId)
    ?? useGlobalSessionsStore.getState().entityById.get(sessionId)
  if (!session) {
    // Events can precede the first session detail. Retire that pending read
    // even without a record, and let the destination recover its transcript.
    const sourceStore = _childStores?.getChild(sourceDirectory)
    _childStores?.ensureChild(destinationDirectory, { bootstrap: false })
    invalidateSessionLoads(sessionId, [sourceDirectory, destinationDirectory])
    if (sourceStore) {
      invalidateMessageSnapshots(sourceStore, sessionId)
      sourceStore.setState(sessionMutationPatch(sourceStore.getState(), sessionId, true))
    }
    dropSessionLiveStateOutside(sessionId, destinationDirectory)
    registerSessionDirectory(sessionId, destinationDirectory)
    useSessionUIStore.getState().setSessionDirectory(sessionId, destinationDirectory)
    return
  }
  relocateSession(session, sourceDirectory, destinationDirectory)
}

function withNewRequests<T extends { id: string }>(current: T[], incoming: T[] | undefined) {
  const added = incoming?.filter((request) => !current.some((existing) => existing.id === request.id)) ?? []
  return added.length > 0 ? [...current, ...added] : current
}

function dropSessionLiveStateOutside(sessionId: string, ownerDirectory: string): void {
  const stores = _childStores
  const owner = stores?.getChild(ownerDirectory)
  if (!stores || !owner) return
  let permissions = owner.getState().permission[sessionId] ?? []
  let forms = owner.getState().form[sessionId] ?? []
  for (const store of stores.children.values()) {
    if (store === owner) continue
    const state = store.getState()
    const holdsSession = [state.message, state.session_status, state.permission, state.form]
      .some((record) => Object.prototype.hasOwnProperty.call(record, sessionId))
      || Object.values(state.part).some((parts) => parts?.some((part) => part.sessionID === sessionId))
    if (!holdsSession) continue
    permissions = withNewRequests(permissions, state.permission[sessionId])
    forms = withNewRequests(forms, state.form[sessionId])
    const draft = {
      message: { ...state.message },
      part: { ...state.part },
      session_status: { ...state.session_status },
      permission: { ...state.permission },
      form: { ...state.form },
    }
    dropSessionCaches(draft, [sessionId])
    store.setState(draft)
  }
  const ownerState = owner.getState()
  if (permissions.length > 0 && permissions !== ownerState.permission[sessionId]) {
    owner.setState({ permission: { ...ownerState.permission, [sessionId]: permissions } })
  }
  if (forms.length > 0 && forms !== ownerState.form[sessionId]) {
    owner.setState({ form: { ...ownerState.form, [sessionId]: forms } })
  }
}

function relocateSession(session: Session, sourceDirectory: string, destinationDirectory: string): Session {
  invalidateSessionLoads(session.id, [sourceDirectory, destinationDirectory])
  const moved = reconcileSessionMove(session, sourceDirectory, destinationDirectory)
  dropSessionLiveStateOutside(session.id, destinationDirectory)
  registerSessionDirectory(session.id, destinationDirectory)
  const ui = useSessionUIStore.getState()
  ui.setSessionDirectory(session.id, destinationDirectory)
  const destinationWorktree = findWorktreeHoldingDirectory(
    [...ui.availableWorktreesByProject.values()].flat(),
    destinationDirectory,
  )
  ui.setWorktreeMetadata(session.id, destinationWorktree ?? null, destinationDirectory)
  useSessionFoldersStore.getState().followSessionMove(session.id, destinationDirectory, destinationWorktree?.path ?? null)
  useGlobalSessionsStore.getState().upsertSession(moved)
  const queueTarget = createMessageQueueTarget(session.id, destinationDirectory)
  if (queueTarget) useMessageQueueStore.getState().followSessionMove(queueTarget)
  followSessionTabMove(session.id, destinationDirectory)
  return moved
}

function dir() {
  return _getDirectory() || undefined
}

function connectionLostError(): ConnectionLostError {
  const { hasEverConnected, lastDisconnectReason } = useConfigStore.getState()
  return new ConnectionLostError({ reason: lastDisconnectReason || null, everConnected: hasEverConnected })
}

const CONNECTION_GRACE_MS = 2000
const CONNECTION_PROBE_MS = 500
const RELAY_CONNECTION_GRACE_MS = 3000
const RELAY_CONNECTION_PROBE_MS = 3000
export async function waitForConnectionOrThrow(): Promise<void> {
  await waitForOpenCodeStartup()
  const relayed = isRelayModeActive()
  const deadline = Date.now() + (relayed ? RELAY_CONNECTION_GRACE_MS : CONNECTION_GRACE_MS)
  const probeMs = relayed ? RELAY_CONNECTION_PROBE_MS : CONNECTION_PROBE_MS
  while (Date.now() < deadline) {
    if (useConfigStore.getState().isConnected) return
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    if (await useConfigStore.getState().probeConnection({ timeoutMs: Math.min(probeMs, remainingMs) })) return
    const sleepMs = Math.min(100, deadline - Date.now())
    if (sleepMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
    }
  }
  throw connectionLostError()
}


type CompactSelection = {
  providerID: string
  modelID: string
  variant?: string | null
}

export async function compactSession(
  sessionId: string,
  selection: CompactSelection | null,
  directory?: string | null,
): Promise<void> {
  const isCurrentRuntime = captureRuntimeInstance()
  const settleModelPick = selection && !isAutoModel(selection.providerID, selection.modelID)
    ? useSelectionStore.getState().captureSessionModelPickSettlement(sessionId, selection.providerID, selection.modelID)
    : undefined
  if (selection && !isAutoModel(selection.providerID, selection.modelID)) {
    const { model } = await resolveSendSelection(sessionId, directory ?? undefined, selection)
    if (!isCurrentRuntime()) throw new Error("Compaction was cancelled because the runtime changed.")
    if (model) {
      await opencodeClient.switchSessionModel(sessionId, model, directory)
    }
  }
  if (!isCurrentRuntime()) throw new Error("Compaction was cancelled because the runtime changed.")
  await opencodeClient.compactSession(sessionId, directory)
  settleModelPick?.()
}

type SessionListSnapshot = {
  directory: string
}

type DirectoryStoreApi = ReturnType<ChildStoreManager["ensureChild"]>

type DescendantSession = {
  session: Session
  directory: string
}

export type SessionLiveActivity = "unknown" | "idle" | "active"

export function getSessionLiveActivity(sessionId: string): SessionLiveActivity {
  const stores = _childStores

  if (stores) {
    for (const [, store] of stores.children) {
      const status = store.getState().session_status?.[sessionId]
      if (status && status.type !== "idle") return "active"
    }
  }

  if (useGlobalSessionStatusStore.getState().statusById.has(sessionId)) return "active"

  if (!stores) return "unknown"
  return hasAuthoritativeIdleCoverage(sessionId, stores) ? "idle" : "unknown"
}

function hasAuthoritativeIdleCoverage(sessionId: string, stores: ChildStoreManager): boolean {
  const directory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
    ?? resolveKnownSessionDirectory(sessionId)
    ?? findSessionDirectoryInChildStores(sessionId)
  if (!directory) return false
  const state = stores.getChild(directory)?.getState()
  return (state?.sessionStatusReady === true && !state.sessionStatusInvalidated?.[sessionId])
    || state?.session_status[sessionId]?.type === "idle"
}

function resolveKnownSessionDirectory(sessionId: string): string | null {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  return globalSession ? resolveGlobalSessionDirectory(globalSession) : null
}

export function isSessionBusyNow(sessionId: string): boolean {
  return getSessionLiveActivity(sessionId) === "active"
}

export async function readSessionsLiveActivity(sessionIds: string[], directory: string): Promise<SessionLiveActivity> {
  const activities = sessionIds.map(getSessionLiveActivity)
  if (activities.includes("active")) return "active"
  if (!activities.includes("unknown")) return "idle"

  const activeStatuses = await opencodeClient.getActiveSessionStatuses(directory)
  if (activeStatuses === null) return "unknown"
  return sessionIds.some((id) => activeStatuses[id] || isSessionBusyNow(id)) ? "active" : "idle"
}

function getDescendantSessions(rootId: string): DescendantSession[] {
  const stores = _childStores
  if (!stores) return []

  const sessionsById = new Map<string, DescendantSession>()
  for (const [storeDirectory, store] of stores.children) {
    const state = store.getState()
    for (const session of state.session) {
      const directory = session.directory || storeDirectory
      const current = sessionsById.get(session.id)
      if (!current || session.directory) sessionsById.set(session.id, { session, directory })
    }
  }

  const subtreeIds = computeSubtreeIds(
    [...sessionsById.values()].map(({ session }) => session),
    rootId,
  )
  subtreeIds.delete(rootId)
  return [...subtreeIds]
    .map((id) => sessionsById.get(id))
    .filter((entry): entry is DescendantSession => !!entry)
}

function firstUserMessageAtOrAfter(messages: Message[], cutoff: number): Message | null {
  let target: Message | null = null
  for (const message of messages) {
    if (message.role !== "user" || message.time.created < cutoff) continue
    if (!target || message.time.created < target.time.created) target = message
  }
  return target
}

async function fetchSessionMessages(sessionId: string, directory?: string | null): Promise<Message[]> {
  const page = await opencodeClient.getSessionMessages(sessionId, undefined, directory)
  return page.items.map(({ info }) => info)
}

function descendantRevertCutoff(state: { session: readonly Session[] }, target: Message): number {
  const run = readSubagentRun(target)
  const child = run ? state.session.find((session) => session.id === run.childSessionID) : undefined
  return child ? Math.min(child.time.created, target.time.created) : target.time.created
}

async function stageAndReadRevert(sessionId: string, messageId: string, directory: string | null | undefined, assertRuntime: () => void): Promise<Session> {
  const key = revertKey(sessionId)
  unreconciledReverts.add(key)
  await opencodeClient.stageRevert(sessionId, messageId, { directory })
  assertRuntime()
  const reverted = await opencodeClient.getSession(sessionId, directory)
  assertRuntime()
  if (reverted.revert?.messageID !== messageId) throw new Error(`Revert was not confirmed for session ${sessionId}`)
  unreconciledReverts.delete(key)
  return reverted
}

const revertFailure = (sessionID: string, cause: unknown) => `${sessionID}: ${cause instanceof Error ? cause.message : String(cause)}`

async function cascadeRevertToDescendants(descendants: DescendantSession[], cutoff: number, assertRuntime: () => void): Promise<string[]> {
  const failures: string[] = []
  for (const { session, directory } of descendants) {
    try {
      assertRuntime()
      await stopSessionExecution(session.id, directory)
      assertRuntime()
      const messages = await fetchSessionMessages(session.id, directory)
      assertRuntime()
      const target = firstUserMessageAtOrAfter(messages, cutoff)
      if (!target) continue
      const reverted = await stageAndReadRevert(session.id, target.id, directory, assertRuntime)
      mirrorSessionIntoLiveStores(reverted, directory)
    } catch (error) {
      assertRuntime()
      failures.push(revertFailure(session.id, error))
    }
  }
  return failures
}

export function clearStagedRevert(sessionId: string): Promise<void> {
  return runRevertOperation(sessionId, () => clearStagedRevertNow(sessionId))
}

async function clearStagedRevertNow(sessionId: string): Promise<void> {
  const { directory } = dirStoreForSession(sessionId)
  if (isSessionBusyNow(sessionId)) await stopSessionExecution(sessionId, directory)
  for (const descendant of getDescendantSessions(sessionId)) {
    if (!descendant.session.revert) continue
    try {
      if (isSessionBusyNow(descendant.session.id)) await stopSessionExecution(descendant.session.id, descendant.directory)
      await opencodeClient.clearRevert(descendant.session.id, descendant.directory)
      mirrorSessionIntoLiveStores(await opencodeClient.getSession(descendant.session.id, descendant.directory), descendant.directory)
    } catch (error) {
      console.error(`[session-actions] Failed to clear revert in descendant ${descendant.session.id}:`, error)
    }
  }
  await opencodeClient.clearRevert(sessionId, directory)
  mirrorSessionIntoLiveStores(await opencodeClient.getSession(sessionId, directory), directory)
  if (directory) {
    sessionEvents.requestGitRefresh({ directory })
    fileTreeChanges.unknownChange(directory)
  }
}

type PendingRevert = { rootId: string; runtimeKey: string; affectsDescendants: boolean; promise: Promise<void> }
const pendingReverts = new Map<string, PendingRevert>()
const unreconciledReverts = new Set<string>()
const revertReconciliations = new Map<string, { promise: Promise<void>; isCurrent: () => boolean }>()
let revertRevision = 0

function revertKey(sessionId: string): string {
  return JSON.stringify([getRuntimeKey(), sessionId])
}

function pendingRevertsForSession(sessionId: string): PendingRevert[] {
  const direct = pendingReverts.get(revertKey(sessionId))
  const entries = new Set<PendingRevert>()
  if (direct) entries.add(direct)
  for (const entry of new Set(pendingReverts.values())) {
    if (entry.runtimeKey !== getRuntimeKey() || !entry.affectsDescendants || entries.has(entry)) continue
    if (getDescendantSessions(entry.rootId).some(({ session }) => session.id === sessionId)) entries.add(entry)
  }
  return [...entries]
}

export async function waitForPendingRevert(sessionId: string, directory?: string | null): Promise<void> {
  const isCurrentRuntime = captureRuntimeInstance()
  let failure: unknown
  const key = revertKey(sessionId)
  while (true) {
    const pending = pendingRevertsForSession(sessionId)
    if (pending.length > 0) {
      const results = await Promise.allSettled(pending.map((entry) => entry.promise))
      if (!isCurrentRuntime()) throw new Error("Runtime changed while waiting for the revert.")
      const failed = results.find((result) => result.status === "rejected")
      if (failed?.status === "rejected") failure = failed.reason
      continue
    }
    if (unreconciledReverts.has(key)) {
      let reconciliation = revertReconciliations.get(key)
      if (!reconciliation) {
        const revision = revertRevision
        const targetDirectory = directory ?? getSessionDirectory(sessionId)
        const read = Promise.resolve().then(async () => {
          const session = await opencodeClient.getSession(sessionId, targetDirectory)
          if (!isCurrentRuntime()) throw new Error("Runtime changed while reconciling the revert.")
          if (revision !== revertRevision || pendingRevertsForSession(sessionId).length > 0) return
          mirrorSessionIntoLiveStores(session, targetDirectory)
          unreconciledReverts.delete(key)
        })
        const promise = read.finally(() => {
          if (revertReconciliations.get(key)?.promise === promise) revertReconciliations.delete(key)
        })
        reconciliation = { promise, isCurrent: isCurrentRuntime }
        revertReconciliations.set(key, reconciliation)
      }
      try {
        await reconciliation.promise
      } catch (error) {
        if (!isCurrentRuntime()) throw error
        if (reconciliation.isCurrent()) throw error
      }
      if (!isCurrentRuntime()) throw new Error("Runtime changed while reconciling the revert.")
      continue
    }
    if (failure) throw failure
    return
  }
}

export async function commitStagedRevert(sessionId: string, directory?: string | null): Promise<void> {
  await waitForPendingRevert(sessionId, directory)
  await runRevertOperation(sessionId, async () => {
    if (!findLiveSession(sessionId)?.revert) return
    await opencodeClient.commitRevert(sessionId, directory)
  }, false)
}

export function commitSessionRevert(sessionId: string, directory?: string | null): Promise<void> {
  return runRevertOperation(sessionId, () => opencodeClient.commitRevert(sessionId, directory), false)
}

function getGlobalSessionSnapshot(sessionId: string): Session | null {
  const global = useGlobalSessionsStore.getState()
  return [...global.activeSessions, ...global.archivedSessions].find((session) => session.id === sessionId) ?? null
}

function findLiveSession(sessionId: string): Session | null {
  if (!_childStores) return null
  for (const store of _childStores.children.values()) {
    const session = store.getState().session.find((item) => item.id === sessionId)
    if (session) return session
  }
  return null
}

function withArchivedAt(sessionId: string, archivedAt: number | null): Session | null {
  const known = getGlobalSessionSnapshot(sessionId) ?? findLiveSession(sessionId)
  if (!known) return null
  const time = { ...known.time }
  if (archivedAt === null) delete time.archived
  else time.archived = archivedAt
  return { ...known, time }
}

const toError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)))

function getSessionDirectory(sessionId: string): string | undefined {
  const globalSession = getGlobalSessionSnapshot(sessionId)
  const globalDirectory = globalSession ? resolveGlobalSessionDirectory(globalSession) ?? undefined : undefined
  return globalDirectory
    || findSessionDirectoryInChildStores(sessionId)
    || useSessionUIStore.getState().getDirectoryForSession(sessionId)
    || dir()
}

function findSessionDirectoryInChildStores(sessionId: string): string | null {
  const stores = _childStores
  if (!stores || !sessionId) return null

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.form ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function getSessionReplyDirectory(sessionId?: string): string | undefined {
  const directory = sessionId
    ? useSessionUIStore.getState().getDirectoryForSession(sessionId)
    : null
  return directory ?? dir()
}

function restoreFilePartsToInput(fileParts: readonly FilePart[], target: ChatDraftIdentity | null): void {
  useInputStore.getState().clearAttachedFiles(target)
  for (const filePart of fileParts) {
    if (!filePart.url) continue
    useInputStore.getState().addRestoredAttachment({
      url: filePart.url,
      mimeType: filePart.mime,
      filename: filePart.filename ?? "attachment",
    }, target)
  }
}

function contextCarriersForMessage(messages: readonly Message[], messageID: string): ContextCarrierPart[] {
  const index = messages.findIndex((message) => message.id === messageID)
  if (index < 0) return []
  const carriers: ContextCarrierPart[] = []
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate.role !== "synthetic") break
    carriers.unshift({ metadata: candidate.metadata })
  }
  return carriers
}

function restoreContextPartsToInput(
  parts: readonly ContextCarrierPart[],
  target: InlineCommentDraftTarget,
): void {
  const store = useInlineCommentDraftStore.getState()
  store.clearDrafts(target)
  for (const part of parts) {
    const payload = readContextPart(part)
    if (!payload) continue
    const draft = draftFromContextPayload(payload)
    if (draft) store.addDraft(target, draft, { written: true })
  }
}

function resolveSessionOwnedDirectory(session: Session): string | null {
  const record = session as Session & {
    directory?: string | null
    project?: { worktree?: string | null } | null
  }
  const raw = typeof record.directory === "string" && record.directory.trim().length > 0
    ? record.directory
    : typeof record.project?.worktree === "string" && record.project.worktree.trim().length > 0
      ? record.project.worktree
      : null
  return raw ? normalizePath(raw) : null
}

function resolveDirectoryForBlockingRequest(
  type: "permission" | "form",
  sessionId: string,
  requestId: string,
): string | null {
  const stores = _childStores
  if (!stores || !requestId) {
    return null
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    const requestMap = type === "permission" ? state.permission : state.form
    for (const requests of Object.values(requestMap) as Array<Array<{ id: string; sessionID?: string }> | undefined>) {
      const request = requests?.find((candidate) => candidate.id === requestId)
      if (!request) continue

      const requestSessionID = typeof request.sessionID === "string" && request.sessionID.length > 0
        ? request.sessionID
        : sessionId
      const sessionRecord = requestSessionID
        ? state.session.find((s) => s.id === requestSessionID)
        : undefined
      const ownedDirectory = sessionRecord ? resolveSessionOwnedDirectory(sessionRecord) : null
      if (ownedDirectory) return ownedDirectory
      return directory
    }
  }

  const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId)
  if (sessionDirectory) {
    return sessionDirectory
  }

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      state.session.some((session) => session.id === sessionId)
      || Object.prototype.hasOwnProperty.call(state.message, sessionId)
      || Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.permission ?? {}, sessionId)
      || Object.prototype.hasOwnProperty.call(state.form ?? {}, sessionId)
    ) {
      return directory
    }
  }

  return null
}

function recoverStaleBlockingRequest(sessionId: string): void {
  const stores = _childStores
  const enqueue = _enqueueSessionMaterialization
  if (!stores || !enqueue || !sessionId) return

  for (const [directory, store] of stores.children) {
    const state = store.getState()
    if (
      !state.session.some((session) => session.id === sessionId)
      && !Object.prototype.hasOwnProperty.call(state.message, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.session_status ?? {}, sessionId)
      && !Object.prototype.hasOwnProperty.call(state.form ?? {}, sessionId)
    ) {
      continue
    }
    const messageID = getStaleRunningToolMessageID(state, sessionId)
    if (messageID) {
      enqueue(directory, sessionId, messageID)
    }
    return
  }
}

function removeFormRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().form ?? {}
    let nextForm: typeof current | null = null
    const sessionIds = sessionId ? [sessionId] : Object.keys(current)

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextForm ??= { ...current }
      if (nextRequests.length > 0) {
        nextForm[candidateSessionId] = nextRequests
      } else {
        delete nextForm[candidateSessionId]
      }
      removed = true
    }

    if (nextForm) {
      store.setState({ form: nextForm })
    }
  }

  return removed
}

function restoreFormRequest(store: DirectoryStoreApi, sessionId: string, form: FormRequest): void {
  store.setState((state) => {
    const forms = state.form[sessionId] ?? []
    const result = Binary.search(forms, form.id, (item) => item.id)
    if (result.found) return state
    const next = [...forms]
    next.splice(result.index, 0, form)
    return { form: { ...state.form, [sessionId]: next } }
  })
}

function restorePermissionRequest(store: DirectoryStoreApi, sessionId: string, permission: PermissionRequest): void {
  store.setState((state) => {
    const permissions = state.permission[sessionId] ?? []
    const result = Binary.search(permissions, permission.id, (item) => item.id)
    if (result.found) return state
    const next = [...permissions]
    next.splice(result.index, 0, permission)
    return { permission: { ...state.permission, [sessionId]: next } }
  })
}

function isPermissionRequestNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    const status = (error as { status?: unknown }).status
    if (status === 404) return true
  }

  let message = ""
  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === "string") {
    message = error
  }

  return /Permission(?:\.)?NotFoundError|Permission request not found/i.test(message)
}

function removePermissionRequestFromChildStores(sessionId: string, requestId: string): boolean {
  const stores = _childStores
  if (!stores || !requestId) return false

  let removed = false
  for (const [, store] of stores.children) {
    const current = store.getState().permission ?? {}
    let nextPermission: typeof current | null = null
    const sessionIds = new Set([sessionId, ...Object.keys(current)].filter(Boolean))

    for (const candidateSessionId of sessionIds) {
      const requests = current[candidateSessionId]
      if (!requests?.length) continue

      const nextRequests = requests.filter((request) => request.id !== requestId)
      if (nextRequests.length === requests.length) continue

      nextPermission ??= { ...current }
      if (nextRequests.length > 0) {
        nextPermission[candidateSessionId] = nextRequests
      } else {
        delete nextPermission[candidateSessionId]
      }
      removed = true
    }

    if (nextPermission) {
      store.setState({ permission: nextPermission })
    }
  }

  return removed
}

function getRequestReplyDirectory(
  type: "permission" | "form",
  sessionId: string,
  requestId: string,
): string | undefined {
  return resolveDirectoryForBlockingRequest(type, sessionId, requestId)
    ?? getSessionReplyDirectory(sessionId)
}

function findSessionRecordAnywhere(sessionId: string, directory: string | undefined): Session | undefined {
  return getDirectoryState(directory)?.session.find((session) => session.id === sessionId)
    ?? getAllSyncSessionMap().get(sessionId)
    ?? useGlobalSessionsStore.getState().entityById.get(sessionId)
}

async function resolveBlockingRequestTarget(
  sessionId: string,
  guessedDirectory: string | undefined,
): Promise<{ record: Session | undefined; directory: string | undefined }> {
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) return { record: undefined, directory: guessedDirectory }
  let record = findSessionRecordAnywhere(sessionId, guessedDirectory)
  if (record === undefined) {
    const readIsCurrent = captureRuntimeInstance()
    let fetched: Session
    try {
      fetched = await opencodeClient.getSession(sessionId, guessedDirectory)
    } catch (error) {
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw new Error("The reply was not sent because its session record could not be read.", { cause: error })
    }
    if (!readIsCurrent()) throw new Error("The reply was cancelled because the runtime changed.")
    record = findSessionRecordAnywhere(sessionId, guessedDirectory) ?? fetched
  }
  return { record, directory: resolveSessionOwnedDirectory(record) ?? guessedDirectory }
}


export type SessionCreateSelection = { model?: ModelSelection; agent?: string }

export async function createSession(
  title?: string,
  directoryOverride?: string | null,
  metadata?: Metadata,
  selectionTransition?: "submitted-draft",
  selection?: SessionCreateSelection,
  navigation: "open" | "preserve" = "open",
  id?: string,
  expectedRuntimeKey?: string,
): Promise<Session | null> {
  const runtimeKey = expectedRuntimeKey ?? getRuntimeKey()
  const runtimeClient = opencodeClient.getSdkClient()
  try {
    if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== runtimeClient) return null
    const effectiveDirectory = directoryOverride ?? dir()
    const cleanupSession = await opencodeClient.captureSessionCleanup(effectiveDirectory, runtimeKey)
    if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== runtimeClient) return null
    const sessionMetadata = title ? withUserWorkTitle(metadata ?? {}, title) : metadata
    const session = await opencodeClient.createSession(
      { id, title, metadata: sessionMetadata, model: selection?.model, agent: selection?.agent },
      effectiveDirectory,
    )

    if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== runtimeClient) {
      await cleanupSession(session.id)
      return null
    }
    const sessionDirectory = session.directory || effectiveDirectory || null
    if (sessionDirectory) {
      registerSessionDirectory(session.id, sessionDirectory)
      const store = _childStores?.ensureChild(sessionDirectory, { bootstrap: false })
      if (store) {
        const current = store.getState().session
        const existing = Binary.search(current, session.id, (candidate) => candidate.id)
        if (!existing.found) {
          store.setState({ session: [...current.slice(0, existing.index), session, ...current.slice(existing.index)] })
        }
      }
      getImperativeSessionMessageLoader()?.initializeCreatedSession({ directory: sessionDirectory, sessionID: session.id })
    }
    if (navigation === "open") useSessionUIStore.getState().setCurrentSession(session.id, sessionDirectory, { transition: selectionTransition })
    useSessionUIStore.getState().markSessionAsOpenChamberCreated(session.id)
    useGlobalSessionsStore.getState().upsertSession(session)
    return session
  } catch (error) {
    console.error("[session-actions] createSession failed", error)
    return null
  }
}

export function openPendingSessionTranscript(sessionId: string, directory: string): void {
  registerSessionDirectory(sessionId, directory)
  _childStores?.ensureChild(directory, { bootstrap: false })
  getImperativeSessionMessageLoader()?.initializeCreatedSession({ directory, sessionID: sessionId })
}

function isStaleRuntime(expectedRuntimeKey: string | undefined): boolean {
  return expectedRuntimeKey !== undefined && getRuntimeKey() !== expectedRuntimeKey
}

const isMetadataRecord = (value: JsonValue | undefined): value is Metadata =>
  value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)

// external: https://www.rfc-editor.org/rfc/rfc7386 Metadata merge patches delete keys with null and preserve untouched nested siblings.
function buildMetadataMergePatch(current: Metadata, next: Metadata): Metadata {
  const patch: Metadata = {}
  for (const key of Object.keys(current)) {
    if (!(key in next)) patch[key] = null
  }
  for (const [key, value] of Object.entries(next)) {
    const previous = current[key]
    if (isMetadataRecord(value) && isMetadataRecord(previous)) {
      const nested = buildMetadataMergePatch(previous, value)
      if (Object.keys(nested).length > 0) patch[key] = nested
      continue
    }
    if (JSON.stringify(previous) !== JSON.stringify(value)) patch[key] = value
  }
  return patch
}

export function patchSessionMetadata(
  sessionId: string,
  directory: string | null | undefined,
  updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
  expectedRuntimeKey?: string,
  forkCleanup?: { workTitle: JsonValue; goal?: JsonValue },
): Promise<Session> {
  return writeSessionMetadataPatch(sessionId, directory, (currentMetadata) => {
    const nextMetadata = updater(currentMetadata)
    // Cleanup removes individual inherited keys, never a namespace another
    // client may have extended since this read.
    if (forkCleanup && isMetadataRecord(currentMetadata.openchamber) && !Object.hasOwn(nextMetadata, "openchamber")) {
      nextMetadata.openchamber = {}
    }
    return buildMetadataMergePatch(currentMetadata, nextMetadata)
  }, expectedRuntimeKey, forkCleanup)
}

/** Goal actions send their intent even when a field matched the earlier read. */
export function patchSessionGoalMetadata(
  sessionId: string,
  directory: string | null | undefined,
  update: (currentGoal: Metadata | null) => Metadata | null,
  expectedRuntimeKey?: string,
): Promise<Session> {
  return writeSessionMetadataPatch(sessionId, directory, (metadata) => {
    const namespace = isMetadataRecord(metadata.openchamber) ? metadata.openchamber : {}
    const currentGoal = isMetadataRecord(namespace.goal) ? namespace.goal : null
    const intent = update(currentGoal)
    if (intent && currentGoal && typeof intent.id === "string" && intent.id !== currentGoal.id) {
      // A fresh goal resets the previous goal's fields, including optional audit
      // state; edits and status actions send only their explicitly chosen fields.
      return { openchamber: { goal: { ...buildMetadataMergePatch(currentGoal, intent), ...intent } } }
    }
    return { openchamber: { goal: intent } }
  }, expectedRuntimeKey)
}

async function writeSessionMetadataPatch(
  sessionId: string,
  directory: string | null | undefined,
  buildPatch: (metadata: Metadata) => Metadata,
  expectedRuntimeKey?: string,
  forkCleanup?: { workTitle: JsonValue; goal?: JsonValue },
): Promise<Session> {
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const current = await opencodeClient.getSession(sessionId, targetDirectory)
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  const currentMetadata = getSessionMetadata(current)
  // OpenCode 2.x only accepts metadata at session creation, so OpenChamber
  // keeps it (see session-archive-batch). The store applies the caller's merge
  // patch inside its metadata write turn. A runtime without that route cannot persist the change, and
  // reporting success would strand a review or btw link that the next load
  // silently drops.
  const patch = buildPatch(currentMetadata)
  const result = await requestSessionMetadataUpdate(sessionId, patch, targetDirectory, isMetadataRecord(patch.openchamber) ? forkCleanup : undefined)
  if (result.outcome !== "updated") throw new Error(`session metadata update failed: ${result.reason}`)
  const updated = withSessionMetadata(current, result.metadata)
  if (isStaleRuntime(expectedRuntimeKey)) throw new Error("runtime changed")
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = updated.directory || targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  mirrorSessionIntoLiveStores(updated, sessionDirectory ?? undefined)
  return updated
}

export async function setLinkedIssue(
  sessionId: string,
  directory: string | null | undefined,
  issue: LinkedIssue,
  linked: boolean,
): Promise<Session> {
  return updateLinkedIssues(sessionId, directory, [issue], linked)
}

export async function addLinkedIssues(
  sessionId: string,
  directory: string | null | undefined,
  issues: readonly LinkedIssue[],
): Promise<Session> {
  return updateLinkedIssues(sessionId, directory, issues, true)
}

async function updateLinkedIssues(
  sessionId: string,
  directory: string | null | undefined,
  issues: readonly LinkedIssue[],
  linked: boolean,
): Promise<Session> {
  const targetDirectory = directory ?? getSessionDirectory(sessionId)
  const heldBeforeRequest = getGlobalSessionSnapshot(sessionId) !== null
    || findLiveSession(sessionId) !== null
  const fallbackRecord = heldBeforeRequest
    ? null
    : await opencodeClient.getSession(sessionId, targetDirectory)
  const result = await requestSessionLinksUpdate(sessionId, issues, linked, targetDirectory)
  if (result.outcome !== "updated") throw new Error(`session link update failed: ${result.reason}`)
  const record = fallbackRecord
    ?? (getGlobalSessionSnapshot(sessionId) ?? findLiveSession(sessionId))
    ?? await opencodeClient.getSession(sessionId, targetDirectory)
  const updated: Session = { ...record, metadata: result.metadata }
  useGlobalSessionsStore.getState().upsertSession(updated)
  const sessionDirectory = updated.directory || targetDirectory
  if (sessionDirectory) registerSessionDirectory(updated.id, sessionDirectory)
  mirrorSessionIntoLiveStores(updated, sessionDirectory ?? undefined)
  return updated
}

export async function setSessionWorkState(
  sessionId: string,
  directory: string | null | undefined,
  state: SessionWork["state"],
): Promise<Session | null> {
  const runtimeKeyAtClick = getRuntimeKey()
  try {
    return await patchSessionMetadata(sessionId, directory, (metadata) =>
      state === "open" && isPinnedMetadata(metadata) ? metadata : withSessionWorkState(metadata, state, Date.now()), runtimeKeyAtClick)
  } catch (error) {
    if (isStaleRuntime(runtimeKeyAtClick)) return null
    throw error
  }
}

export async function setSessionPinned(
  sessionId: string,
  directory: string | null | undefined,
  pinned: boolean,
  list: string | null = null,
): Promise<Session | null> {
  const runtimeKeyAtClick = getRuntimeKey()
  try {
    return await patchSessionMetadata(sessionId, directory, (metadata) => {
      const now = Date.now()
      const next = withSessionPinned(metadata, pinned, now, list)
      return pinned ? withSessionWorkClosed(next, now) : next
    }, runtimeKeyAtClick)
  } catch (error) {
    if (isStaleRuntime(runtimeKeyAtClick)) return null
    throw error
  }
}

export async function setContextObligatoryMessage(
  sessionId: string,
  directory: string | null | undefined,
  message: ContextObligatoryMessage,
  pinned: boolean,
): Promise<Session> {
  return patchSessionMetadata(sessionId, directory, (metadata) =>
    withContextObligatoryMessage(metadata, message, pinned, sessionId))
}

async function cleanupReviewMetadataBeforeDelete(
  sessionId: string,
  directory?: string | null,
  expectedRuntimeKey?: string,
): Promise<void> {
  if (isStaleRuntime(expectedRuntimeKey)) return
  let session: Session
  try {
    session = await opencodeClient.getSession(sessionId, directory ?? getSessionDirectory(sessionId))
  } catch {
    return
  }
  if (isStaleRuntime(expectedRuntimeKey)) return

  const unlinkParent = async (originalSessionID: string, unlink: (metadata: SessionMetadataRecord) => SessionMetadataRecord) => {
    try {
      await patchSessionMetadata(originalSessionID, directory ?? getSessionDirectory(originalSessionID), unlink, expectedRuntimeKey)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) return
      console.warn("[session-actions] linked-session metadata cleanup failed before delete", error)
    }
  }

  if (isReviewSession(session)) {
    const originalSessionID = getOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutReviewSessionLink(metadata, sessionId))
    return
  }

  if (isBtwSession(session)) {
    const originalSessionID = getBtwOriginalSessionID(session)
    if (originalSessionID) await unlinkParent(originalSessionID, (metadata) => withoutBtwSessionLink(metadata, sessionId))
    return
  }

  const btwSessionID = getBtwSessionID(session)
  if (btwSessionID) {
    try {
      if (isStaleRuntime(expectedRuntimeKey)) return
      await deleteSession(btwSessionID, { expectedRuntimeKey })
    } catch (error) {
      console.warn("[session-actions] failed to delete btw fork before parent delete", error)
    }
  }
}

function removeSessionFromLiveStores(sessionId: string, preferredDirectory?: string, archive = false): SessionListSnapshot[] {
  if (!_childStores) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    if (!current.session.some((session) => session.id === sessionId)) {
      continue
    }
    snapshots.push({ directory })
    const patch: Partial<ReturnType<DirectoryStoreApi["getState"]>> = {
      session: current.session.filter((session) => session.id !== sessionId),
      ...sessionMutationPatch(current, sessionId, true),
    }
    if (archive) {
      patch.session_status = { ...current.session_status }
      delete patch.session_status[sessionId]
      patch.sessionStatusInvalidated = { ...current.sessionStatusInvalidated, [sessionId]: true }
    }
    store.setState(patch)
  }

  return snapshots
}

function removeSessionsFromLiveStores(sessionIds: Iterable<string>, preferredDirectory?: string, archive = false): SessionListSnapshot[] {
  const ids = new Set(sessionIds)
  if (!_childStores || ids.size === 0) return []

  const snapshots: SessionListSnapshot[] = []
  const visited = new Set<string>()
  const candidates: Array<[string, DirectoryStoreApi]> = []

  if (preferredDirectory) {
    const preferredStore = _childStores.children.get(preferredDirectory)
    if (preferredStore) {
      candidates.push([preferredDirectory, preferredStore])
      visited.add(preferredDirectory)
    }
  }

  for (const entry of _childStores.children.entries()) {
    if (visited.has(entry[0])) continue
    candidates.push(entry)
  }

  for (const [directory, store] of candidates) {
    const current = store.getState()
    const removed = current.session.filter((session) => ids.has(session.id)).map((session) => session.id)
    if (removed.length === 0) continue

    snapshots.push({ directory })
    const patch: Partial<ReturnType<DirectoryStoreApi["getState"]>> = {
      session: current.session.filter((session) => !ids.has(session.id)),
      ...sessionsMutationPatch(current, removed, true),
    }
    if (archive) {
      patch.session_status = { ...current.session_status }
      patch.sessionStatusInvalidated = { ...current.sessionStatusInvalidated }
      for (const id of removed) {
        delete patch.session_status[id]
        patch.sessionStatusInvalidated[id] = true
      }
    }
    store.setState(patch)
  }

  return snapshots
}

function cleanupSessionWorktreeMetadata(sessionId: string): void {
  useSessionUIStore.getState().setWorktreeMetadata(sessionId, null)
}

function getKnownSessionSubtreeIds(sessionId: string): string[] {
  const ids = new Set([sessionId])
  for (const store of _childStores?.children.values() ?? []) {
    for (const id of computeSubtreeIds(store.getState().session, sessionId)) ids.add(id)
  }
  return [...ids]
}

function cleanupSessionDataInLiveStores(sessionIds: readonly string[]): void {
  if (!_childStores || sessionIds.length === 0) return
  const deleted = new Set(sessionIds)
  for (const store of _childStores.children.values()) {
    const current = store.getState()
    const applicable = sessionIds.filter((sessionId) =>
      current.session.some((session) => session.id === sessionId)
      || current.message[sessionId] !== undefined
      || current.session_status[sessionId] !== undefined
      || current.permission[sessionId] !== undefined
      || current.form[sessionId] !== undefined,
    )
    // Even an empty store can have a pre-deletion list request in flight.
    const revision = sessionsMutationPatch(current, sessionIds, true)
    if (applicable.length === 0) {
      store.setState(revision)
      continue
    }
    const cache = {
      session: current.session.filter((session) => !deleted.has(session.id)),
      session_status: { ...current.session_status },
      message: { ...current.message },
      part: { ...current.part },
      permission: { ...current.permission },
      form: { ...current.form },
    }
    dropSessionCaches(cache, applicable)
    store.setState({ ...cache, ...revision })
  }
}

/** Commit a server-confirmed deletion without crossing the captured runtime. */
function finalizeConfirmedSessionDeletion(
  sessionId: string,
  deletedSessionIds: readonly string[],
  sessionDirectory?: string,
  expectedRuntimeKey = getRuntimeKey(),
): void {
  useGlobalSessionsStore.getState().removeSessions(deletedSessionIds)
  cleanupSessionDataInLiveStores(deletedSessionIds)
  for (const store of _childStores?.children.values() ?? []) {
    const invalidated = store.getState().sessionStatusInvalidated
    if (!deletedSessionIds.some((id) => invalidated?.[id])) continue
    const next = { ...invalidated }
    for (const id of deletedSessionIds) delete next[id]
    store.setState({ sessionStatusInvalidated: next })
  }
  for (const deletedSessionId of deletedSessionIds) {
    invalidateSessionLoads(deletedSessionId, [
      ...(_childStores?.children.keys() ?? []),
      sessionDirectory,
    ])
  }
  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
  cleanupSessionWorktreeMetadata(sessionId)
  if (sessionDirectory) {
    cleanupPersistedSessionState({
      runtimeKey: expectedRuntimeKey,
      directory: sessionDirectory,
      sessionId,
    })
  }
}

export function reconcileExternallyDeletedSession(identity: {
  runtimeKey: string
  directory: string
  sessionId: string
}): void {
  if (isStaleRuntime(identity.runtimeKey)) return
  finalizeConfirmedSessionDeletion(identity.sessionId, getKnownSessionSubtreeIds(identity.sessionId), identity.directory, identity.runtimeKey)
}

export function isChatDirectoryStillReferenced(directory: string, excludedIds: ReadonlySet<string>): boolean {
  const global = useGlobalSessionsStore.getState()
  if (!global.hasLoaded) return true
  const normalized = normalizePath(directory)
  return [...global.activeSessions, ...global.archivedSessions].some((session) => (
    !excludedIds.has(session.id) && resolveGlobalSessionDirectory(session) === normalized
  ))
}

export type DeleteSessionOptions = {
  expectedRuntimeKey?: string
}

async function isConfirmedReadOnlyArchive(sessionId: string): Promise<boolean> {
  if (isVSCodeRuntime()) return false
  try {
    return (await readSpaceArchiveChatState(sessionId, AbortSignal.timeout(5_000))).readOnly
  } catch {
    // No affirmative identity means no exemption. The normal Stop path still
    // has to succeed; a read-only denial or any other 409 is not ignored.
    return false
  }
}

export async function deleteSession(sessionId: string, options?: DeleteSessionOptions): Promise<boolean> {
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const deletedSessionIds = getKnownSessionSubtreeIds(sessionId)
  const readOnlyArchive = await isConfirmedReadOnlyArchive(sessionId)
  if (isStaleRuntime(expectedRuntimeKey)) return false
  try {
    if (!readOnlyArchive) await stopSessionExecution(sessionId, sessionDirectory ?? undefined)
  } catch (error) {
    if (await confirmMissingSessionAfterStopFailure(getErrorStatus(error), sessionId, sessionDirectory, expectedRuntimeKey) && !isStaleRuntime(expectedRuntimeKey)) {
      finalizeConfirmedSessionDeletion(sessionId, deletedSessionIds, sessionDirectory, expectedRuntimeKey)
      return true
    }
    if (isStaleRuntime(expectedRuntimeKey)) return false
    recordSessionActionFailure(sessionId, toError(error))
    return false
  }
  if (isStaleRuntime(expectedRuntimeKey)) return false
  try {
    if (!readOnlyArchive) await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    const deleted = await opencodeClient.deleteSession(sessionId, sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (deleted !== true) {
      throw new Error("session.delete failed: server did not confirm deletion")
    }
    finalizeConfirmedSessionDeletion(sessionId, deletedSessionIds, sessionDirectory, expectedRuntimeKey)
    return true
  } catch (error) {
    console.error("[session-actions] deleteSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    if ((error as { status?: number })?.status === 404) {
      if (isStaleRuntime(expectedRuntimeKey)) return false
      finalizeConfirmedSessionDeletion(sessionId, deletedSessionIds, sessionDirectory, expectedRuntimeKey)
      return true
    }
    return false
  }
}

async function confirmMissingSessionAfterStopFailure(
  stopStatus: number | null,
  sessionId: string,
  directory: string | undefined,
  expectedRuntimeKey: string,
): Promise<boolean> {
  if (stopStatus !== 404 || isStaleRuntime(expectedRuntimeKey)) return false
  try {
    await opencodeClient.getSession(sessionId, directory)
    return false
  } catch (confirmationError) {
    return getErrorStatus(confirmationError) === 404 && !isStaleRuntime(expectedRuntimeKey)
  }
}

export type DeleteSessionsOptions = {
  expectedRuntimeKey?: string
}

export async function deleteSessions(
  ids: string[],
  options?: DeleteSessionsOptions,
): Promise<{ deletedIds: string[]; failedIds: string[] }> {
  const deletedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()

  for (const [index, id] of ids.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ids.slice(index))
      break
    }
    if (await deleteSession(id, { expectedRuntimeKey })) deletedIds.push(id)
    else failedIds.push(id)
  }

  return { deletedIds, failedIds }
}

export async function archiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  const archivedAt = Date.now()
  try {
    await cleanupReviewMetadataBeforeDelete(sessionId, sessionDirectory, expectedRuntimeKey)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (!sessionDirectory) throw new Error("archive failed: session directory is unknown")
    const result = await requestSessionArchiveBatch(sessionDirectory, [sessionId], archivedAt)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (result.outcome !== "archived") {
      throw new Error(`archive failed: ${result.reason}`)
    }
    const stamp = result.archived.find((entry) => entry.id === sessionId)
    if (!stamp) {
      throw new Error("archive failed: server did not return the archived session")
    }
    const archived = withArchivedAt(sessionId, stamp.archivedAt)
    const snapshots = removeSessionFromLiveStores(sessionId, sessionDirectory, true)
    invalidateSessionLoads(sessionId, [...snapshots.map((snapshot) => snapshot.directory), sessionDirectory])
    if (archived) useGlobalSessionsStore.getState().upsertSession(archived)
    const ui = useSessionUIStore.getState()
    if (ui.currentSessionId === sessionId) ui.setCurrentSession(null)
    cleanupSessionDataInLiveStores([sessionId])
    return true
  } catch (error) {
    console.error("[session-actions] archiveSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    return false
  }
}

export type ArchiveSessionsOptions = {
  expectedRuntimeKey?: string
}

export async function archiveSessions(
  ids: string[],
  options?: ArchiveSessionsOptions,
): Promise<{ archivedIds: string[]; failedIds: string[] }> {
  const archivedIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()
  if (ids.length === 0) return { archivedIds, failedIds }

  const plan = planArchiveBatches(ids)

  for (const [directory, batchIds] of plan.batchesByDirectory) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...batchIds)
      continue
    }

    const archivedAt = Date.now()
    registerBulkArchiveEchoes(
      expectedRuntimeKey,
      batchIds.map((id) => ({ id, archivedAt })),
    )
    const result = await requestSessionArchiveBatch(directory, batchIds, archivedAt)
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...batchIds)
      continue
    }

    if (result.outcome === "archived") {
      releaseBulkArchiveEchoes(expectedRuntimeKey, batchIds)
      registerBulkArchiveEchoes(
        expectedRuntimeKey,
        result.archived,
      )
      commitArchivedSessions(result.archived, directory)
      archivedIds.push(...result.archived.map((entry) => entry.id))
      failedIds.push(...result.failedIds)
      continue
    }

    console.warn("[session-actions] archive batch unavailable, archiving one by one", result.reason)
    releaseBulkArchiveEchoes(expectedRuntimeKey, batchIds)
    plan.individualIds.push(...batchIds)
  }

  for (const [index, id] of plan.individualIds.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...plan.individualIds.slice(index))
      break
    }
    if (await archiveSession(id, expectedRuntimeKey)) archivedIds.push(id)
    else failedIds.push(id)
  }

  return { archivedIds, failedIds }
}

function hasLinkedSessionCleanup(session: Session): boolean {
  return isReviewSession(session) || isBtwSession(session) || Boolean(getBtwSessionID(session))
}

function planArchiveBatches(ids: string[]) {
  const global = useGlobalSessionsStore.getState()
  const knownSessions = new Map<string, Session>()
  for (const session of [...global.activeSessions, ...global.archivedSessions]) {
    knownSessions.set(session.id, session)
  }
  for (const store of _childStores?.children.values() ?? []) {
    for (const session of store.getState().session) knownSessions.set(session.id, session)
  }

  const batchesByDirectory = new Map<string, string[]>()
  const individualIds: string[] = []

  for (const id of ids) {
    const session = knownSessions.get(id)
    const directory = session
      ? resolveGlobalSessionDirectory(session) ?? getSessionDirectory(id)
      : undefined
    if (!session || !directory || hasLinkedSessionCleanup(session)) {
      individualIds.push(id)
      continue
    }
    const batch = batchesByDirectory.get(directory)
    if (batch) batch.push(id)
    else batchesByDirectory.set(directory, [id])
  }

  return { batchesByDirectory, individualIds }
}

function commitArchivedSessions(stamps: SessionArchiveStamp[], directory: string): void {
  if (stamps.length === 0) return

  const ids = stamps.map((stamp) => stamp.id)
  const archived = stamps.flatMap((stamp) => withArchivedAt(stamp.id, stamp.archivedAt) ?? [])
  const snapshots = removeSessionsFromLiveStores(ids, directory, true)
  const directories = [...snapshots.map((snapshot) => snapshot.directory), directory]
  for (const id of ids) invalidateSessionLoads(id, directories)

  useGlobalSessionsStore.getState().upsertSessions(archived)

  const ui = useSessionUIStore.getState()
  if (ui.currentSessionId && ids.includes(ui.currentSessionId)) ui.setCurrentSession(null)
}

export async function unarchiveSession(sessionId: string, expectedRuntimeKey = getRuntimeKey()): Promise<boolean> {
  const { restoredIds } = await restoreSessionTree(sessionId, expectedRuntimeKey)
  return restoredIds.includes(sessionId)
}

const archivedSubsessionIds = (rootId: string): string[] =>
  readGlobalSessionLineage().descendantsOf(rootId, "archived").map((session) => session.id)

async function restoreSessionTree(
  rootId: string,
  expectedRuntimeKey: string,
): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  const { entityById } = useGlobalSessionsStore.getState()
  const root = entityById.get(rootId)
  if (root && !isRestorableOnItsOwn(root, entityById)) {
    recordSessionActionFailure(rootId, new Error("a subsession is restored with its parent"))
    return { restoredIds: [], failedIds: [rootId] }
  }
  const subsessionIds = archivedSubsessionIds(rootId)
  if (!await restoreArchivedSession(rootId, expectedRuntimeKey)) return { restoredIds: [], failedIds: [rootId] }
  const restoredIds = [rootId]
  const failedIds: string[] = []
  for (const id of subsessionIds) {
    if (await restoreArchivedSession(id, expectedRuntimeKey)) restoredIds.push(id)
    else failedIds.push(id)
  }
  return { restoredIds, failedIds }
}

async function restoreArchivedSession(
  sessionId: string,
  expectedRuntimeKey: string,
  { relocate = true }: { relocate?: boolean } = {},
): Promise<boolean> {
  if (isStaleRuntime(expectedRuntimeKey)) return false
  const sessionDirectory = getSessionDirectory(sessionId)
  try {
    const result = await requestSessionUnarchiveBatch([sessionId], sessionDirectory)
    if (isStaleRuntime(expectedRuntimeKey)) return false
    if (result.outcome !== "restored") {
      throw new Error(`unarchive failed: ${result.reason}`)
    }
    if (!result.restored.includes(sessionId)) {
      throw new Error("unarchive failed: server did not return the restored session")
    }
    const restored = withArchivedAt(sessionId, null)
    if (restored) useGlobalSessionsStore.getState().upsertSession(restored)
    markSessionUnreadSeen(sessionId)
    if (sessionDirectory) registerSessionDirectory(sessionId, sessionDirectory)
    promoteRestoredSessionOrdering(sessionId)
    const store = sessionDirectory ? _childStores?.getChild(sessionDirectory) : undefined
    if (store) {
      const before = store.getState()
      const sdk = opencodeClient.getSdkClient()
      const acceptStatus = beginSessionStatusRequest(store)
      // The restore already committed. A rejected status read is unknown, not
      // an action failure or a reason to mark this session idle.
      await readDirectoryStatusSnapshot(store, () => opencodeClient.getActiveSessionStatuses(sessionDirectory), (statuses) => {
        if (isStaleRuntime(expectedRuntimeKey) || opencodeClient.getSdkClient() !== sdk
          || !sessionDirectory || _childStores?.getChild(sessionDirectory) !== store) return false
        const current = store.getState()
        if (current.sessionStatusInvalidated !== before.sessionStatusInvalidated
          || current.session_status[sessionId] !== before.session_status[sessionId]
          || !acceptStatus()) return false
        const invalidated = { ...current.sessionStatusInvalidated }
        delete invalidated[sessionId]
        store.setState({
          session_status: { ...current.session_status, [sessionId]: statuses[sessionId] ?? { type: "idle" } },
          sessionStatusInvalidated: invalidated,
        })
        return true
      }).catch(() => null)
    }
    if (relocate && !isStaleRuntime(expectedRuntimeKey)) {
      void import("@/lib/worktrees/relocateRestoredSession")
        .then((module) => module.relocateRestoredSessionWithNotice(sessionId))
        .catch((error: unknown) => console.warn("[session-actions] restored session relocation failed", error))
    }
    return true
  } catch (error) {
    console.error("[session-actions] unarchiveSession failed", error)
    recordSessionActionFailure(sessionId, toError(error))
    return false
  }
}

export type UnarchiveSessionsOptions = {
  expectedRuntimeKey?: string
  undo?: boolean
}

export async function unarchiveSessions(
  ids: string[],
  options?: UnarchiveSessionsOptions,
): Promise<{ restoredIds: string[]; failedIds: string[] }> {
  const restoredIds: string[] = []
  const failedIds: string[] = []
  const expectedRuntimeKey = options?.expectedRuntimeKey ?? getRuntimeKey()
  const settled = new Set<string>()
  const entityById = useGlobalSessionsStore.getState().entityById
  const ordered = options?.undo
    ? ids
    : [...ids.filter((id) => !entityById.get(id)?.parentID), ...ids.filter((id) => entityById.get(id)?.parentID)]

  for (const [index, id] of ordered.entries()) {
    if (isStaleRuntime(expectedRuntimeKey)) {
      failedIds.push(...ordered.slice(index).filter((pending) => !settled.has(pending)))
      break
    }
    if (settled.has(id)) continue
    if (options?.undo) {
      if (await restoreArchivedSession(id, expectedRuntimeKey, { relocate: false })) restoredIds.push(id)
      else failedIds.push(id)
      settled.add(id)
      continue
    }
    const outcome = await restoreSessionTree(id, expectedRuntimeKey)
    for (const restored of outcome.restoredIds) settled.add(restored)
    for (const failed of outcome.failedIds) settled.add(failed)
    restoredIds.push(...outcome.restoredIds)
    failedIds.push(...outcome.failedIds)
  }

  return { restoredIds, failedIds }
}

export async function updateSessionTitle(
  sessionId: string,
  title: string,
  options?: { directory?: string | null; expectedRuntimeKey?: string; signal?: AbortSignal; byUser?: boolean },
): Promise<void> {
  if (isStaleRuntime(options?.expectedRuntimeKey)) throw new Error("runtime changed")
  if (options?.signal) options.signal.throwIfAborted()
  else cancelSessionTitleGeneration(sessionId)
  const sessionDirectory = options?.directory ?? getSessionDirectory(sessionId)
  await opencodeClient.renameSession(sessionId, title, sessionDirectory)
  const session = await opencodeClient.getSession(sessionId, sessionDirectory)
  if (isStaleRuntime(options?.expectedRuntimeKey)) throw new Error("runtime changed")
  options?.signal?.throwIfAborted()
  useGlobalSessionsStore.getState().upsertSession(session)
  mirrorSessionIntoLiveStores(session, sessionDirectory)
  if (options?.byUser) {
    await patchSessionMetadata(sessionId, sessionDirectory, (metadata) => withUserWorkTitle(metadata, title), options.expectedRuntimeKey)
      .catch(() => undefined)
  }
}


export function markSessionStatus(sessionId: string, directory: string | null | undefined, type: "busy" | "idle"): void {
  const store = directory ? dirStoreForDirectory(directory) : dirStore()
  const current = store.getState()
  store.setState({
    session_status: {
      ...current.session_status,
      [sessionId]: { type },
    },
  })
}

export async function optimisticSend(input: {
  runtimeKey?: string
  sessionId: string
  content: string
  directory?: string | null
  files?: Array<{ type: "file"; mime: string; url: string; filename: string }>
  context?: SyntheticContextInput[]
  ready?: Promise<void>
  appendSubmissions?: () => void
  onOptimisticInsert?: (messageID: string) => void
  markBusy?: boolean
  /**
   * The actual API call. Receives the user message id for reconciliation and
   * context with client-local preview ids, omitted at the SDK boundary.
   */
  send: (messageID: string, context: SyntheticContextInput[]) => Promise<void>
}): Promise<void> {
  if (!_optimisticAdd || !_optimisticRemove) {
    throw new Error("Optimistic refs not set — is useSync() mounted?")
  }
  const optimisticAdd = _optimisticAdd
  const optimisticRemove = _optimisticRemove
  const expectedRuntimeKey = input.runtimeKey ?? getRuntimeKey()
  const isCurrentRuntime = captureRuntimeInstance()

  const assertRuntimeUnchanged = () => {
    if (expectedRuntimeKey !== getRuntimeKey()) {
      throw new Error("Message was not sent because the runtime changed.")
    }
  }

  assertRuntimeUnchanged()
  await waitForConnectionOrThrow()
  assertRuntimeUnchanged()
  await waitForPendingRevert(input.sessionId, input.directory)
  assertRuntimeUnchanged()
  input.appendSubmissions?.()

  const targetDirectory = input.directory ?? dir()
  const store = targetDirectory ? dirStoreForDirectory(targetDirectory) : dirStore()
  let stateBeforeSend = store.getState()
  let sessionBeforeSend = stateBeforeSend.session.find((session) => session.id === input.sessionId)
  let revertMessageID = sessionBeforeSend?.revert?.messageID
  let sessionMessages = stateBeforeSend.message[input.sessionId] ?? []
  let revertBoundary = revertMessageID
    ? sessionMessages.findIndex((message) => message.id === revertMessageID)
    : -1

  while (revertMessageID && revertBoundary < 0) {
    const expectedRevertMessageID = revertMessageID
    const loader = getImperativeSessionMessageLoader()
    if (!loader || !targetDirectory) {
      throw new Error("Reverted session history is not available yet.")
    }
    const found = await loader.loadUntil(
      { directory: targetDirectory, sessionID: input.sessionId },
      { kind: "message", messageID: expectedRevertMessageID },
    )
    assertRuntimeUnchanged()

    stateBeforeSend = store.getState()
    sessionBeforeSend = stateBeforeSend.session.find((session) => session.id === input.sessionId)
    revertMessageID = sessionBeforeSend?.revert?.messageID
    sessionMessages = stateBeforeSend.message[input.sessionId] ?? []
    revertBoundary = revertMessageID
      ? sessionMessages.findIndex((message) => message.id === revertMessageID)
      : -1

    if (revertMessageID === expectedRevertMessageID && (!found || revertBoundary < 0)) {
      throw new Error("Reverted session history could not be loaded.")
    }
  }

  assertRuntimeUnchanged()
  const sdk = opencodeClient.getSdkClient()
  const messagesBeforeSend = sessionMessages
  const revertedMessages = selectRevertedMessages(messagesBeforeSend, revertMessageID)
  const revertedParts = new Map(
    revertedMessages.map((message) => [message.id, stateBeforeSend.part[message.id] ?? []] as const),
  )

  if (revertMessageID) {
    const session = stateBeforeSend.session.map((candidate) => (
      candidate.id === input.sessionId ? { ...candidate, revert: undefined } as Session : candidate
    ))
    const message = {
      ...stateBeforeSend.message,
      [input.sessionId]: revertBoundary >= 0 ? sessionMessages.slice(0, revertBoundary) : sessionMessages,
    }
    const part = { ...stateBeforeSend.part }
    for (const revertedMessage of revertedMessages) delete part[revertedMessage.id]
    store.setState({ session, message, part })

    for (const revertedMessage of revertedMessages) {
      _optimisticConfirm?.({
        sessionID: input.sessionId,
        directory: targetDirectory,
        messageID: revertedMessage.id,
      })
    }
  }

  const context = (input.context ?? [])
    .filter((item) => item.text.trim())
    .map((item) => ({ ...item, id: ascendingId("msg") }))
  const messageID = ascendingId("msg")
  const optimisticIDs = [...context.map((item) => item.id), messageID]

  const optimisticParts: Part[] = [
    { id: partIds.userText(messageID), sessionID: input.sessionId, messageID, type: "text", text: input.content },
  ]
  if (input.files) {
    input.files.forEach((file, index) => {
      optimisticParts.push({
        id: partIds.userFile(messageID, index),
        sessionID: input.sessionId,
        messageID,
        type: "file",
        mime: file.mime,
        url: file.url,
        filename: file.filename,
      })
    })
  }

  const created = Date.now()
  const optimisticMessage: UserMessage = {
    id: messageID,
    role: "user",
    sessionID: input.sessionId,
    time: { created },
  }

  const addSyntheticContext = (item: SyntheticContextInput & { id: string }) => {
    const synthetic: SyntheticMessage = compact({
      id: item.id,
      role: "synthetic",
      sessionID: input.sessionId,
      time: { created },
      text: item.text,
      description: item.description,
      metadata: item.metadata ? toJsonRecord(item.metadata) : undefined,
    })
    optimisticAdd({ sessionID: input.sessionId, directory: targetDirectory, message: synthetic, parts: [] })
  }
  for (const item of context) addSyntheticContext(item)
  optimisticAdd({
    sessionID: input.sessionId,
    directory: targetDirectory,
    message: optimisticMessage,
    parts: optimisticParts,
  })
  input.onOptimisticInsert?.(messageID)

  if (input.markBusy !== false) markSessionStatus(input.sessionId, targetDirectory, "busy")

  const releasePrompt = trackPromptInFlight(input.sessionId)
  let requestSent = false
  try {
    await input.ready
    assertRuntimeUnchanged()
    requestSent = true
    await input.send(messageID, context)
    // A completed send still succeeded at its original runtime. Its previews
    // must not be removed from a replacement store, including a round-trip switch.
    if (!isCurrentRuntime() || opencodeClient.getSdkClient() !== sdk || (targetDirectory && _childStores?.getChild(targetDirectory) !== store)) return
    // These are previews of inline prompt context. Their canonical synthetic
    // message IDs are assigned by OpenCode when the owning prompt is delivered.
    for (const optimisticID of optimisticIDs) {
      if (optimisticID === messageID) continue
      optimisticRemove({ sessionID: input.sessionId, directory: targetDirectory, messageID: optimisticID })
    }
  } catch (error) {
    if (requestSent) {
      assertRuntimeUnchanged()
      if (opencodeClient.getSdkClient() !== sdk || (targetDirectory && _childStores?.getChild(targetDirectory) !== store)) throw error
    }
    const loader = getImperativeSessionMessageLoader()
    const target = targetDirectory ? { directory: targetDirectory, sessionID: input.sessionId } : undefined
    const generation = target ? loader?.getSnapshot(target).generation : undefined
    const status = getErrorStatus(error)
    const ambiguousFailure = requestSent && isAmbiguousSendFailure(error)
    const accepted = ambiguousFailure
      ? await confirmRecentSend(store, input.sessionId, messageID, targetDirectory)
      : false

    if (requestSent) {
      assertRuntimeUnchanged()
      if (opencodeClient.getSdkClient() !== sdk || (targetDirectory && _childStores?.getChild(targetDirectory) !== store)) throw error
    }
    if (accepted) {
      for (const optimisticID of optimisticIDs) {
        if (optimisticID !== messageID) {
          optimisticRemove({ sessionID: input.sessionId, directory: targetDirectory, messageID: optimisticID })
          continue
        }
        if (!accepted.includes(optimisticID)) continue
        _optimisticConfirm?.({ sessionID: input.sessionId, directory: targetDirectory, messageID: optimisticID })
      }
      return
    }
    if (requestSent && (getImperativeSessionMessageLoader() !== loader || (target && loader?.getSnapshot(target).generation !== generation))) throw error

    const failureRecord = {
      sessionId: input.sessionId,
      messageId: messageID,
      directory: targetDirectory ?? null,
      status,
      ambiguous: ambiguousFailure,
      confirmationChecked: ambiguousFailure,
      reason: error instanceof Error ? error.message : String(error),
    }
    recordSendFailure(failureRecord)
    console.warn("[session-actions] prompt send rejected; rolling back optimistic message", failureRecord)

    // Admission commits the revert atomically. A lost response may still have
    // committed it even when confirmation could not find the delivered prompt.
    const revertStaged = revertMessageID && ambiguousFailure
      ? await opencodeClient.getSession(input.sessionId, targetDirectory).then((record) => !!record.revert, () => true)
      : true
    if (requestSent) {
      assertRuntimeUnchanged()
      if (opencodeClient.getSdkClient() !== sdk || (targetDirectory && _childStores?.getChild(targetDirectory) !== store)) throw error
    }

    // Rollback via optimistic infrastructure. Admitted context comes back
    // with its owning prompt in the next history read. The records
    // are where the session lives now: a session created from a draft can
    // have moved to another directory than the one its message was shown in.
    const rollbackDirectory = getSessionDirectory(input.sessionId) ?? targetDirectory
    const rollbackStore = rollbackDirectory && rollbackDirectory !== targetDirectory ? dirStoreForDirectory(rollbackDirectory) : store
    for (const optimisticID of optimisticIDs) {
      optimisticRemove({
        sessionID: input.sessionId,
        directory: rollbackDirectory,
        messageID: optimisticID,
      })
    }
    const rollbackState = rollbackStore.getState()
    let session = rollbackState.session
    let message = rollbackState.message
    let part = rollbackState.part

    if (revertMessageID && revertStaged) {
      session = rollbackState.session.map((candidate) => (
        candidate.id === input.sessionId ? { ...candidate, revert: sessionBeforeSend?.revert } as Session : candidate
      ))
      message = {
        ...rollbackState.message,
        [input.sessionId]: mergeMessages(rollbackState.message[input.sessionId] ?? [], revertedMessages),
      }
      part = { ...rollbackState.part }
      for (const [revertedMessageID, parts] of revertedParts) {
        part[revertedMessageID] = parts
      }
    }

    rollbackStore.setState({
      session,
      message,
      part,
      session_status: {
        ...rollbackState.session_status,
        [input.sessionId]: { type: "idle" as const },
      },
    })
    throw error
  } finally {
    releasePrompt()
  }
}

async function confirmRecentSend(
  store: DirectoryStoreApi,
  sessionId: string,
  messageID: string,
  directory?: string | null,
): Promise<string[] | false> {
  const runtime = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const loader = getImperativeSessionMessageLoader()
  const target = directory ? { directory, sessionID: sessionId } : undefined
  const generation = target ? loader?.getSnapshot(target).generation : undefined
  const snapshot = beginMessageSnapshot(store, sessionId)
  const isCurrent = () => snapshot.isCurrent() && getRuntimeKey() === runtime && opencodeClient.getSdkClient() === sdk
    && (!directory || _childStores?.getChild(directory) === store)
    && getImperativeSessionMessageLoader() === loader && (!target || loader?.getSnapshot(target).generation === generation)
  try {
    // Bounded: a connection that never returns must still let the send fail
    // rather than hang the composer.
    const reconnectDeadline = Date.now() + SEND_CONFIRMATION_RECONNECT_TIMEOUT_MS
    while (isCurrent() && !useConfigStore.getState().isConnected && Date.now() < reconnectDeadline) {
      await wait(SEND_CONFIRMATION_RECONNECT_POLL_MS)
    }

    for (let attempt = 0; attempt < SEND_CONFIRMATION_REFETCH_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await wait(SEND_CONFIRMATION_REFETCH_BASE_RETRY_MS * 2 ** (attempt - 1))
      if (!isCurrent()) return false
      try {
        const page = await opencodeClient.getSessionMessages(sessionId, { limit: SEND_CONFIRMATION_REFETCH_LIMIT }, directory)
        if (!isCurrent()) return false
        if (page.items.some((record) => record.info.id === messageID)) {
          const records = snapshot.reconcile(page.items)
          const materialized = materializeSessionSnapshots(store.getState(), sessionId, records)
          store.setState({ message: materialized.message, part: materialized.part })
          return records.map((record) => record.info.id)
        }
      } catch {
        // Confirmation is best-effort; if it fails, keep the original send error path.
      }
    }
    return false
  } finally {
    snapshot.dispose()
  }
}

export async function stopSessionExecution(
  sessionId: string,
  directoryOverride?: string,
): Promise<void> {
  if (!sessionId) throw new Error("Cannot stop a session without an id")
  const directory = directoryOverride ?? getSessionDirectory(sessionId)
  await opencodeClient.stopSession(sessionId, directory)
}


export async function respondToPermission(
  sessionId: string,
  requestId: string,
  response: "once" | "always" | "reject",
  directoryOverride?: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const directory = directoryOverride || (await resolveBlockingRequestTarget(
    sessionId,
    resolveDirectoryForBlockingRequest("permission", sessionId, requestId) || getSessionDirectory(sessionId),
  )).directory
  try {
    if (await opencodeClient.replyToPermission(sessionId, requestId, response, { directory }) !== true) {
      throw new Error("Permission reply failed")
    }
  } catch (error) {
    if (isPermissionRequestNotFoundError(error)) {
      removePermissionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

export async function dismissPermission(
  sessionId: string,
  requestId: string,
): Promise<void> {
  await waitForConnectionOrThrow()
  const { directory } = await resolveBlockingRequestTarget(
    sessionId,
    resolveDirectoryForBlockingRequest("permission", sessionId, requestId) || getSessionDirectory(sessionId),
  )
  try {
    if (await opencodeClient.replyToPermission(sessionId, requestId, "reject", { directory }) !== true) {
      throw new Error("Permission dismissal failed")
    }
  } catch (error) {
    if (isPermissionRequestNotFoundError(error)) {
      removePermissionRequestFromChildStores(sessionId, requestId)
    }
    throw error
  }
}

export async function dismissOpenPermissionsForSession(sessionId: string): Promise<boolean> {
  if (!sessionId) return false
  const stores = _childStores
  if (!stores) return false

  const toDismiss: Array<{ store: DirectoryStoreApi; sessionId: string; permission: PermissionRequest }> = []
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const permissionsBySession = state.permission ?? {}
    for (const scopedId of scopedIds) {
      const requests = permissionsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        toDismiss.push({ store, sessionId: scopedId, permission: request })
      }
    }
  }

  if (toDismiss.length === 0) return false

  for (const { sessionId: scopedSessionId, permission } of toDismiss) {
    removePermissionRequestFromChildStores(scopedSessionId, permission.id)
  }

  await Promise.all(
    toDismiss.map(async ({ store, sessionId: scopedSessionId, permission }) => {
      try {
        await dismissPermission(scopedSessionId, permission.id)
      } catch (error) {
        if (isPermissionRequestNotFoundError(error)) return
        console.error("[session-actions] Failed to dismiss open permission on send:", error)
        restorePermissionRequest(store, scopedSessionId, permission)
      }
    }),
  )
  return true
}


export type FormAnswer = Record<string, string | number | boolean | string[]>

type FormSelection = {
  model?: { providerID: string; modelID: string; variant?: string | null }
  agent?: string
}

function resolveFormSelection(record: Session | undefined, sessionId: string): FormSelection {
  const picks = useSelectionStore.getState()
  const agentPick = picks.getSessionAgentPick(sessionId) ?? undefined
  if (
    record
    && (isReviewSession(record) || !record.parentID)
    && useSessionUIStore.getState().currentSessionId === sessionId
  ) {
    const config = useConfigStore.getState()
    return {
      agent: agentPick ?? config.currentAgentName ?? undefined,
      model: config.currentProviderId && config.currentModelId
        ? {
            providerID: config.currentProviderId,
            modelID: config.currentModelId,
            variant: config.currentVariantSelection.override === null ? null : config.currentVariant,
          }
        : undefined,
    }
  }
  const recordModel = record?.model
  const modelPick = picks.getSessionModelPick(sessionId)
  const model = modelPick ?? (recordModel ? { providerId: recordModel.providerID, modelId: recordModel.id } : null)
  const agent = agentPick ?? record?.agent
  const savedEffort = model && agent
    ? picks.getAgentModelVariantForSession(sessionId, agent, model.providerId, model.modelId)
    : undefined
  const effortPicked = savedEffort !== undefined && !(recordModel
    && picks.isSessionModelSwitched(sessionId, `${recordModel.providerID}/${recordModel.id}#${recordModel.variant ?? ""}`))
  if (!model || (!modelPick && !effortPicked)) return { agent: agentPick }
  const recordEffort = recordModel?.providerID === model.providerId && recordModel.id === model.modelId
    ? recordModel.variant
    : undefined
  return {
    agent: agentPick,
    model: { providerID: model.providerId, modelID: model.modelId, variant: effortPicked ? savedEffort : recordEffort },
  }
}

async function applyFormSelection(record: Session | undefined, sessionId: string, directory: string | undefined, runtimeKey: string): Promise<() => void> {
  if (sessionId === LOCATION_SCOPED_FORM_SESSION_ID) return () => {}
  const { model, agent } = resolveFormSelection(record, sessionId)
  if (!model && !agent) return () => {}
  const settleModelPick = model
    ? useSelectionStore.getState().captureSessionModelPickSettlement(sessionId, model.providerID, model.modelID, runtimeKey)
    : undefined
  const selection = await resolveCheckedSendSelection(sessionId, directory, {
    providerID: model?.providerID ?? "",
    modelID: model?.modelID ?? "",
    variant: model?.variant,
    agent,
  })
  await opencodeClient.applySendSelection(
    sessionId,
    { model: model ? selection.model : undefined, agent: selection.agent },
    directory,
    runtimeKey,
  )
  return () => settleModelPick?.()
}

export async function applyModelPickToRetry(sessionId: string, directory: string | undefined): Promise<void> {
  const pick = useSelectionStore.getState().getSessionModelPick(sessionId)
  if (!pick || isAutoModel(pick.providerId, pick.modelId)) return
  const { model } = resolveFormSelection(findSessionRecordAnywhere(sessionId, directory), sessionId)
  if (model?.providerID !== pick.providerId || model.modelID !== pick.modelId) return
  const settleModelPick = useSelectionStore.getState().captureSessionModelPickSettlement(sessionId, model.providerID, model.modelID)
  await opencodeClient.switchSessionModel(sessionId, { providerID: model.providerID, id: model.modelID, variant: model.variant }, directory)
  settleModelPick()
}

export async function replyToForm(
  sessionId: string,
  formId: string,
  answer: FormAnswer,
): Promise<void> {
  const isCurrentRuntime = captureRuntimeInstance()
  const runtimeKey = getRuntimeKey()
  const assertRuntimeCurrent = () => {
    if (!isCurrentRuntime()) throw new Error("Form reply was cancelled because the runtime changed.")
  }
  await waitForConnectionOrThrow()
  assertRuntimeCurrent()
  try {
    const { record, directory: replyDirectory } = await resolveBlockingRequestTarget(
      sessionId,
      getRequestReplyDirectory("form", sessionId, formId),
    )
    const settleSelection = await applyFormSelection(record, sessionId, replyDirectory, runtimeKey)
    assertRuntimeCurrent()
    if (await opencodeClient.replyToForm(sessionId, formId, answer, replyDirectory) !== true) {
      throw new Error("Form reply failed")
    }
    if (!isCurrentRuntime()) return
    settleSelection()
    removeFormRequestFromChildStores(sessionId, formId)
    noteLocalFormReplied(sessionId, formId)
  } catch (error) {
    if (isCurrentRuntime() && isFormRequestNotFoundError(error)) {
      removeFormRequestFromChildStores(sessionId, formId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

export async function cancelForm(sessionId: string, formId: string, message?: string): Promise<void> {
  await waitForConnectionOrThrow()
  const { directory } = await resolveBlockingRequestTarget(sessionId, getRequestReplyDirectory("form", sessionId, formId))
  try {
    if (await opencodeClient.cancelForm(sessionId, formId, directory, message) !== true) {
      throw new Error("Form cancellation failed")
    }
    removeFormRequestFromChildStores(sessionId, formId)
    if (message === undefined) noteLocalFormCancelled(sessionId, formId)
  } catch (error) {
    if (isFormRequestNotFoundError(error)) {
      removeFormRequestFromChildStores(sessionId, formId)
      recoverStaleBlockingRequest(sessionId)
    }
    throw error
  }
}

type RecoveredAnswerSelection = {
  providerID: string
  modelID: string
  agent?: string
  variant?: string
}

function recoveredAnswerSelection(question: RecoveredQuestion): RecoveredAnswerSelection {
  const state = dirStoreForDirectory(question.directory).getState()
  const message = state.message[question.sessionID]?.find((candidate) => candidate.id === question.toolMessageID)
  if (message?.role === "assistant") {
    return {
      providerID: message.providerID,
      modelID: message.modelID,
      agent: message.agent,
      variant: message.variant,
    }
  }
  const session = state.session.find((candidate) => candidate.id === question.sessionID)
  if (session?.model) {
    return {
      providerID: session.model.providerID,
      modelID: session.model.id,
      agent: session.agent,
      variant: session.model.variant,
    }
  }
  const saved = useSelectionStore.getState().getSessionModelSelection(question.sessionID)
  if (saved) {
    return {
      providerID: saved.providerId,
      modelID: saved.modelId,
      agent: useSelectionStore.getState().getSessionAgentSelection(question.sessionID) ?? undefined,
    }
  }
  throw new Error("No model is recorded for this question")
}

/** Uses the normal send path for rollback and ambiguous-failure confirmation. */
export async function sendRecoveredFormAnswer(question: RecoveredQuestion, text: string, answer: Record<string, FormValue>): Promise<void> {
  const runtimeKey = getRuntimeKey()
  const isCurrentRuntime = captureRuntimeInstance()
  const deferred = question.evidence === "deferred-on-send"
  await submitRecoveredAnswer(question.form.id, async () => {
    const selection = recoveredAnswerSelection(question)
    await useSessionUIStore.getState().sendMessage(
      deferred ? `${DEFERRED_ANSWER_LEAD_IN}\n\n${text}` : text,
      selection.providerID,
      selection.modelID,
      selection.agent,
      undefined,
      undefined,
      undefined,
      selection.variant,
      "normal",
      {
        userInitiated: true,
        queuedGoal: null,
        target: { runtimeKey, sessionId: question.sessionID, directory: question.directory },
        metadata: { ...recoveredQuestionAnswerMetadata(question, answer), ...(deferred && deferredAnswerMetadata(question.form.id)) },
      },
    )
    if (isCurrentRuntime()) noteLocalFormReplied(question.sessionID, question.form.id)
  })
}

function openFormReleaseKeys(): Set<string> {
  const keys = new Set<string>()
  for (const [, store] of _childStores?.children ?? []) {
    for (const forms of Object.values(store.getState().form ?? {})) {
      for (const form of forms ?? []) {
        const tool = formToolLink(form)
        if (tool) keys.add(formReleaseKey(form, tool))
      }
    }
  }
  return keys
}

const formToolReads = new Map<string, { read: Promise<boolean>; isCurrentRuntime: () => boolean }>()

function readFormToolLink(form: FormRequest): Promise<boolean> {
  const tool = formToolLink(form)
  if (!tool) return Promise.resolve(false)
  const key = formReleaseKey(form, tool)
  const existing = formToolReads.get(key)
  if (existing?.isCurrentRuntime()) return existing.read
  const isCurrentRuntime = captureRuntimeInstance()
  const read = (async () => {
    try {
      const { directory } = await resolveBlockingRequestTarget(form.sessionID, getRequestReplyDirectory("form", form.sessionID, form.id))
      const parts = { [tool.messageID]: (await opencodeClient.getSessionMessage(form.sessionID, tool.messageID, directory)).parts }
      if (!isCurrentRuntime()) return false
      if (formTurnHold(form, parts) !== "released") return isWaitingQuestionCall(form, parts)
      const openKeys = openFormReleaseKeys()
      if (openKeys.has(key)) noteFormToolReleased(key, openKeys)
    } catch (error) {
      console.error("[session-actions] Could not read the tool call of an open form:", error)
    }
    return false
  })().finally(() => {
    if (formToolReads.get(key)?.read === read) formToolReads.delete(key)
  })
  formToolReads.set(key, { read, isCurrentRuntime })
  return read
}

export function readUnloadedFormToolLinks(sessionId: string): void {
  const releasedForms = useRecoverableQuestionsStore.getState().releasedForms
  for (const [, store] of _childStores?.children ?? []) {
    const state = store.getState()
    for (const form of state.form?.[sessionId] ?? []) {
      if (formTurnHold(form, state.part, releasedForms) === "unknown") void readFormToolLink(form)
    }
  }
}

type OpenFormCopy = { store: DirectoryStoreApi; sessionId: string; form: FormRequest }

function formCopiesHold(copies: readonly OpenFormCopy[]): "holds" | "released" | "unknown" {
  const releasedForms = useRecoverableQuestionsStore.getState().releasedForms
  const holds = copies.map(({ store, form }) => formTurnHold(form, store.getState().part, releasedForms))
  if (holds.includes("released")) return "released"
  return holds.includes("unknown") ? "unknown" : "holds"
}

export async function dismissOpenFormsForSession(
  sessionId: string,
  options?: { deferQuestions?: boolean },
): Promise<{ dismissed: boolean; deferred: readonly FormRequest[] }> {
  const nothing = { dismissed: false, deferred: [] }
  if (!sessionId) return nothing
  const stores = _childStores
  if (!stores) return nothing

  const isCurrentRuntime = captureRuntimeInstance()
  const copiesByForm = new Map<string, OpenFormCopy[]>()
  for (const [, store] of stores.children) {
    const state = store.getState()
    const scopedIds = computeSubtreeIds(state.session, sessionId)
    if (scopedIds.size === 0) continue
    const formsBySession: Record<string, FormRequest[]> = state.form ?? {}
    for (const scopedId of scopedIds) {
      const requests = formsBySession[scopedId]
      if (!requests) continue
      for (const request of requests) {
        const formKey = `${scopedId}\u0000${request.id}`
        const copies = copiesByForm.get(formKey) ?? []
        copies.push({ store, sessionId: scopedId, form: request })
        copiesByForm.set(formKey, copies)
      }
    }
  }

  const unread = [...copiesByForm.values()].filter((copies) => formCopiesHold(copies) === "unknown")
  const readAsWaitingQuestion = new Set<readonly OpenFormCopy[]>()
  if (unread.length > 0) {
    await Promise.all(unread.map(async (copies) => {
      if (await readFormToolLink(copies[0].form)) readAsWaitingQuestion.add(copies)
    }))
    if (!isCurrentRuntime()) return nothing
  }
  const deferred: FormRequest[] = []
  const toDismiss: OpenFormCopy[][] = []
  for (const copies of copiesByForm.values()) {
    if (formCopiesHold(copies) === "released") continue
    const deferrable = options?.deferQuestions && copies[0].sessionId === sessionId
      && (readAsWaitingQuestion.has(copies) || copies.some(({ store, form }) => isWaitingQuestionCall(form, store.getState().part)))
    if (deferrable) deferred.push(copies[0].form)
    else toDismiss.push(copies)
  }
  if (toDismiss.length === 0) return { dismissed: false, deferred }

  for (const [{ sessionId: scopedSessionId, form }] of toDismiss) {
    removeFormRequestFromChildStores(scopedSessionId, form.id)
  }

  await Promise.all(
    toDismiss.map(async (copies) => {
      const [{ sessionId: scopedSessionId, form }] = copies
      try {
        await cancelForm(scopedSessionId, form.id)
      } catch (error) {
        if (isFormRequestNotFoundError(error)) return
        console.error("[session-actions] Failed to cancel open form on send:", error)
        for (const copy of copies) restoreFormRequest(copy.store, copy.sessionId, copy.form)
      }
    }),
  )
  return { dismissed: true, deferred }
}

export async function deferQuestionsAfterSend(forms: readonly FormRequest[], sent: SentMessage | undefined): Promise<void> {
  if (sent?.route !== "prompt") return
  await Promise.all(forms.filter((form) => form.sessionID === sent.sessionId).map(async (form) => {
    try {
      await cancelForm(form.sessionID, form.id, DEFERRED_QUESTION_NOTE)
    } catch (error) {
      if (error instanceof Error && isFormAlreadySettledError(error)) {
        removeFormRequestFromChildStores(form.sessionID, form.id)
        recoverStaleBlockingRequest(form.sessionID)
      } else if (!isFormRequestNotFoundError(error)) {
        console.error("[session-actions] Could not defer an open question after a send:", error)
      }
    }
  }))
}


function runRevertOperation(sessionId: string, action: () => Promise<void>, includeDescendants = true): Promise<void> {
  revertRevision += 1
  const descendants = includeDescendants ? getDescendantSessions(sessionId) : []
  const sessionIds = [sessionId, ...descendants.map(({ session }) => session.id)]
  const keys = sessionIds.map(revertKey)
  const previous = [...new Set(sessionIds.flatMap((id) => pendingRevertsForSession(id).map((entry) => entry.promise)))]
  const isCurrentRuntime = captureRuntimeInstance()
  const operation = Promise.resolve().then(async () => {
    const results = await Promise.allSettled(previous)
    const failed = results.find((result) => result.status === "rejected")
    if (failed?.status === "rejected") throw failed.reason
    if (!isCurrentRuntime()) throw new Error("Runtime changed while waiting for the revert.")
    await action()
  })
  const tracked = operation.finally(() => {
    for (const key of keys) {
      if (pendingReverts.get(key)?.promise === tracked) pendingReverts.delete(key)
    }
  })
  const entry = { rootId: sessionId, runtimeKey: getRuntimeKey(), affectsDescendants: includeDescendants, promise: tracked }
  for (const key of keys) pendingReverts.set(key, entry)
  return tracked
}

export function revertToMessage(sessionId: string, messageId: string): Promise<void> {
  return runRevertOperation(sessionId, () => stageRevertToMessage(sessionId, messageId))
}

async function stageRevertToMessage(sessionId: string, messageId: string): Promise<void> {
  const isCurrentRuntime = captureRuntimeInstance()
  if (isRunningSubagentRunMessage(messageId)) throw new Error("Cannot revert a running subagent entry")
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  const assertCurrent = () => {
    if (!isCurrentRuntime() || isStaleRuntime(expectedRuntimeKey) || (directory && _childStores?.getChild(directory) !== store)) {
      throw new Error("Revert was invalidated by a runtime or directory change")
    }
  }
  let targetMsg = store.getState().message[sessionId]?.find((message) => message.id === messageId)
  if (!targetMsg) {
    await ensureSessionMessageRequirement(sessionId, { kind: "message", messageID: messageId })
    assertCurrent()
    targetMsg = store.getState().message[sessionId]?.find((message) => message.id === messageId)
  }

  if (!targetMsg || (targetMsg.role !== "user" && !readSubagentRun(targetMsg))) {
    throw new Error(`Cannot revert session: prompt or subagent report ${messageId} was not found`)
  }

  await stopSessionExecution(sessionId, directory)
  assertCurrent()
  const contextLoaded = targetMsg.role !== "user" || await ensureSessionMessageRequirement(sessionId, { kind: "message-context", messageID: messageId })
  assertCurrent()
  if (!contextLoaded) throw new Error("Revert message context could not be loaded")
  const stoppedState = store.getState()
  targetMsg = stoppedState.message[sessionId]?.find((message) => message.id === messageId)
  if (!targetMsg || (targetMsg.role !== "user" && !readSubagentRun(targetMsg))) {
    throw new Error(`Revert target ${messageId} disappeared before staging`)
  }

  let parts = stoppedState.part[messageId] ?? []
  if (targetMsg.role === "user" && !Object.hasOwn(stoppedState.part, messageId)) {
    try {
      const record = await opencodeClient.getSessionMessage(sessionId, messageId, directory)
      assertCurrent()

      // Prefer an event that arrived while the exact read was in flight.
      const refreshed = store.getState()
      parts = Object.hasOwn(refreshed.part, messageId) ? refreshed.part[messageId] ?? [] : record.parts
    } catch (error) {
      assertCurrent()
      // Missing parts are already an exceptional cache/data state. Keep this
      // fallback best-effort: one exact read, no pagination or retry loop.
      console.error("[sync] Failed to load revert target parts", { sessionId, messageId, error })
    }
  }
  const state = store.getState()
  targetMsg = state.message[sessionId]?.find((message) => message.id === messageId)
  if (!targetMsg || (targetMsg.role !== "user" && !readSubagentRun(targetMsg))) {
    throw new Error(`Revert target ${messageId} disappeared before staging`)
  }

  // Extract message text for prompt restoration.
  const messages = state.message[sessionId] ?? []
  let messageText = ""
  let submittedFileParts: FilePart[] = []
  let submittedContextParts: readonly ContextCarrierPart[] = []
  if (targetMsg && targetMsg.role === "user") {
    messageText = parts
      .filter((part): part is TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    submittedFileParts = parts.filter((part): part is FilePart => part.type === "file")
    submittedContextParts = contextCarriersForMessage(messages, messageId)
  }
  const revertMessageID = transcriptCutForMessage(messages, messageId)

  const prevRevert = state.session.find((candidate) => candidate.id === sessionId)?.revert
  const sessions = [...state.session]
  const sessionIdx = sessions.findIndex((s) => s.id === sessionId)

  if (sessionIdx >= 0) {
    sessions[sessionIdx] = { ...sessions[sessionIdx], revert: { messageID: revertMessageID } }
    store.setState({ session: sessions })
  }

  const prevRestoreText = useInputStore.getState().pendingSessionRestores.get(sessionId) ?? null
  const draftTarget: InlineCommentDraftTarget | null = directory
    ? { directory, sessionKey: sessionId }
    : null
  const restoreIdentity = createChatDraftIdentity(getRuntimeKey(), directory, sessionId)
  const prevTargetAttachments = useInputStore.getState().getAttachedFiles(restoreIdentity)
  const prevDrafts = draftTarget ? useInlineCommentDraftStore.getState().getDrafts(draftTarget) : []

  const restoredText = targetMsg?.role === "user"
    ? withMissingCitations(messageText ?? "", submittedFileParts.filter((part) => part.url).map((part) => ({ filename: attachmentBasename(part.filename ?? "attachment") })))
    : messageText
  if (restoredText) {
    useInputStore.getState().setPendingSessionRestore(sessionId, restoredText)
  }

  if (targetMsg?.role === "user") {
    restoreFilePartsToInput(submittedFileParts, restoreIdentity)
    if (draftTarget) restoreContextPartsToInput(submittedContextParts, draftTarget)
  }

  let failures: string[] = []
  try {
    failures = await cascadeRevertToDescendants(getDescendantSessions(sessionId), descendantRevertCutoff(state, targetMsg), assertCurrent)
    const revertedSession = await stageAndReadRevert(sessionId, revertMessageID, directory, assertCurrent)
    const current = store.getState()
    const updated = [...current.session]
    const idx = updated.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      updated[idx] = revertedSession
      store.setState({ session: updated })
    }
    if (directory) {
      sessionEvents.requestGitRefresh({ directory })
      fileTreeChanges.unknownChange(directory)
    }
  } catch (err) {
    assertCurrent()
    const current = store.getState()
    const rollback = [...current.session]
    const idx = rollback.findIndex((s) => s.id === sessionId)
    if (idx >= 0) {
      rollback[idx] = { ...rollback[idx], revert: prevRevert }
    }
    store.setState({
      session: rollback,
    })
    useInputStore.getState().setPendingSessionRestore(sessionId, prevRestoreText)
    useInputStore.getState().setAttachedFiles(prevTargetAttachments, restoreIdentity)
    if (draftTarget) {
      useInlineCommentDraftStore.getState().clearDrafts(draftTarget)
      useInlineCommentDraftStore.getState().restoreDrafts(draftTarget, prevDrafts)
    }
    if (failures.length) throw new Error([...failures, revertFailure(sessionId, err)].join("; "))
    throw err
  }
  if (failures.length) throw new Error(`Partial revert: ${failures.join("; ")}`)
}

export async function refetchSessionMessages(sessionId: string, complete = false): Promise<void> {
  const { store, directory } = dirStoreForSession(sessionId)
  const loader = getImperativeSessionMessageLoader()
  if (loader && directory) {
    if (complete) {
      await loader.refreshComplete({ directory, sessionID: sessionId })
    } else {
      await loader.refreshTail({ directory, sessionID: sessionId }, MESSAGE_REFETCH_LIMIT)
    }
    const snapshot = loader.getSnapshot({ directory, sessionID: sessionId })
    if (snapshot.status === "error") throw snapshot.error ?? new Error("Session message refresh failed")
    return
  }

  // Actions can run in isolated tests before SyncProvider binds the shared
  // loader. The application runtime always takes the shared path above.
  const runtime = getRuntimeKey()
  const sdk = opencodeClient.getSdkClient()
  const snapshot = beginMessageSnapshot(store, sessionId)
  try {
    const records: MessagePage["items"] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await opencodeClient.getSessionMessages(sessionId, { limit: MESSAGE_REFETCH_LIMIT, cursor }, directory)
      if (!snapshot.isCurrent() || getRuntimeKey() !== runtime || opencodeClient.getSdkClient() !== sdk
        || (directory && _childStores?.getChild(directory) !== store)) throw new Error("Session history refresh was invalidated")
      records.push(...page.items)
      cursor = page.cursor.next
      if (cursor && (seen.has(cursor) || page.items.length === 0)) throw new Error("Session history did not advance")
      if (cursor) seen.add(cursor)
    } while (complete && cursor)
    const recentBoundary = records.reduce<number | undefined>((boundary, record) =>
      boundary === undefined ? record.info.seq : Math.min(boundary, record.info.seq), undefined)
    const materialized = materializeSessionSnapshots(
      store.getState(),
      sessionId,
      snapshot.reconcile(records, true),
      { mode: complete || !cursor ? "complete" : "recent", recentBoundary },
    )
    store.setState({ message: materialized.message, part: materialized.part })
  } finally {
    snapshot.dispose()
  }
}

function openForkedSession(store: DirectoryStoreApi, forkedSession: Session, directory: string | null | undefined) {
  const sessions = [...store.getState().session]
  const searchResult = Binary.search(sessions, forkedSession.id, (s) => s.id)
  if (!searchResult.found) {
    sessions.splice(searchResult.index, 0, forkedSession)
    store.setState({ session: sessions })
  }
  useSessionUIStore.getState().setCurrentSession(forkedSession.id, directory)
}

async function inheritForkState(sourceSessionId: string, forkedSession: Session, directory: string | null | undefined, expectedRuntimeKey: string) {
  if (isVSCodeRuntime()) {
    try {
      const { usePermissionStore } = await import("@/stores/permissionStore")
      if (isStaleRuntime(expectedRuntimeKey)) return
      await usePermissionStore.getState().hydrate()
      if (isStaleRuntime(expectedRuntimeKey)) return
      const permissions = usePermissionStore.getState()
      if (!Object.hasOwn(permissions.modes, forkedSession.id)) {
        await permissions.setSessionMode(forkedSession.id, permissions.getSessionMode(sourceSessionId))
      }
    } catch (error) {
      console.warn("[fork] failed to copy the permission mode to the fork", error)
    }
    if (isStaleRuntime(expectedRuntimeKey)) return
  }
  return applyForkInheritance(sourceSessionId, forkedSession, {
    readGoalId: async (sessionId) => getSessionGoal(await opencodeClient.getSession(sessionId, directory))?.id ?? null,
    readObjective: fetchGoalObjectiveContent,
    writeObjective: (id, content) => writeGoalObjectiveFile(id, content, { ifAbsent: true }),
    setPermissions: (sessionId, permissions) => opencodeClient.setSessionPermissions(sessionId, permissions, directory),
    patchMetadata: async (sessionId, updater) => {
      const namespace = forkedSession.metadata?.openchamber
      const workTitle = isMetadataRecord(namespace) ? namespace.workTitle ?? null : null
      const goal = isMetadataRecord(namespace) ? namespace.goal ?? null : null
      await patchSessionMetadata(sessionId, directory, updater, expectedRuntimeKey, { workTitle, goal })
    },
  })
}

export async function forkAfterMessage(sessionId: string, messageId: string): Promise<Session | null> {
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  const messages = store.getState().message[sessionId] ?? []

  const forkedSession = await forkAtTranscriptCut(sessionId, transcriptCutAfterMessage(messages, messageId), directory, expectedRuntimeKey)
  if (isStaleRuntime(expectedRuntimeKey)) return null
  const forkDirectory = resolveSessionOwnedDirectory(forkedSession) ?? directory
  openForkedSession(store, forkedSession, forkDirectory)
  await inheritForkState(sessionId, forkedSession, forkDirectory, expectedRuntimeKey)
  return forkedSession
}

const opensTurn = (messages: readonly Message[], index: number): boolean => {
  for (let before = index - 1; before >= 0; before -= 1) {
    const message = messages[before]
    if (message.role !== "assistant") continue
    return message.time.completed !== undefined && message.finish !== "tool-calls"
  }
  return true
}

export function findLastCompletedTurnMessageId(messages: readonly Message[], turnRunning: boolean): string | null {
  let end = messages.length
  if (turnRunning) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (isTurnBoundary(messages[index]) && opensTurn(messages, index)) {
        end = index
        break
      }
    }
  }
  for (let index = end - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === "assistant" && message.time.completed !== undefined) return message.id
  }
  return null
}

export class NothingToForkError extends Error {
  constructor() {
    super("No completed turn to fork from")
    this.name = "NothingToForkError"
  }
}

export async function forkFromLastCompletedTurn(sessionId: string): Promise<Session | null> {
  const { store } = dirStoreForSession(sessionId)
  const state = store.getState()
  const status = state.session_status?.[sessionId]
  const turnRunning = status !== undefined && status.type !== "idle"
  const messageId = findLastCompletedTurnMessageId(state.message[sessionId] ?? [], turnRunning)
  if (!messageId) throw new NothingToForkError()
  return forkAfterMessage(sessionId, messageId)
}

export async function forkFromMessage(sessionId: string, messageId: string): Promise<void> {
  const expectedRuntimeKey = getRuntimeKey()
  const { store, directory } = dirStoreForSession(sessionId)
  const state = store.getState()

  const parts = state.part[messageId] ?? []
  const messageText = parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  const fileParts = parts.filter((part): part is FilePart => part.type === "file")

  const forkedSession = await opencodeClient.forkSession(sessionId, {
    before: transcriptCutForMessage(state.message[sessionId] ?? [], messageId),
    directory,
  })
  if (isStaleRuntime(expectedRuntimeKey)) return
  const target = createChatDraftIdentity(expectedRuntimeKey, resolveSessionOwnedDirectory(forkedSession) ?? directory, forkedSession.id)
  if (!target) throw new Error("Forked session has no composer directory")

  openForkedSession(store, forkedSession, target.directory)

  useInputStore.setState({
    pendingComposerRestore: {
      target,
      text: messageText,
      files: fileParts.filter((part) => part.url).map((part) => ({
        url: part.url,
        mimeType: part.mime,
        filename: part.filename ?? "attachment",
      })),
    },
  })
  restoreContextPartsToInput(
    contextCarriersForMessage(state.message[sessionId] ?? [], messageId),
    { directory: target.directory, sessionKey: forkedSession.id },
  )
  await inheritForkState(sessionId, forkedSession, target.directory, expectedRuntimeKey)
}

export async function fetchMessagesForSession(sessionID: string, directory?: string | null): Promise<void> {
  const resolvedDir = directory ?? dir()
  if (!resolvedDir) return
  await getImperativeSessionMessageLoader()?.ensure(
    { directory: resolvedDir, sessionID },
    { reason: "navigation" },
  )
}
