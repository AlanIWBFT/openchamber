/**
 * Sync refs — imperative access to sync state from non-React code.
 *
 * SyncProvider sets these refs on mount. Store actions (session-ui-store,
 * session-actions) use them to read child-store domain data without hooks.
 */

import type { OpenCodeClient } from "@opencode/client"
import type { Config } from "@/lib/opencode/model"
import type { ChildStoreManager } from "./child-store"
import { getSessionMaterializationStatus } from "./materialization"
import type { State } from "./types"
import { recordSessionRouting } from "@/lib/diagnostics/session-routing"

let _childStores: ChildStoreManager | null = null
let _directory: string = ""
let _registerSessionDirectory: ((sessionID: string, directory: string) => void) | null = null
const configListeners = new Set<(directory: string, config: Config) => void>()
let cachedSessionManager: ChildStoreManager | null = null
let cachedSessionSlices = new Map<string, State["session"]>()
let cachedSessionsById = new Map<string, State["session"][number]>()
let cachedSessionDirectoryById = new Map<string, string>()

export function setSyncRefs(
  _sdk: OpenCodeClient,
  childStores: ChildStoreManager,
  directory: string,
  registerSessionDirectory?: (sessionID: string, directory: string) => void,
) {
  _childStores = childStores
  if (cachedSessionManager !== childStores) {
    cachedSessionManager = null
    cachedSessionSlices = new Map()
    cachedSessionsById = new Map()
    cachedSessionDirectoryById = new Map()
  }
  _directory = directory
  if (registerSessionDirectory) {
    _registerSessionDirectory = registerSessionDirectory
  }
}

/** Pre-register a session→directory mapping in the routing index.
 *  Called from session-actions when creating sessions so SSE events
 *  arriving before session.created can be routed correctly. */
export function registerSessionDirectory(sessionID: string, directory: string) {
  _registerSessionDirectory?.(sessionID, directory)
}

export function getSyncChildStores(): ChildStoreManager {
  if (!_childStores) throw new Error("ChildStoreManager not initialized — is SyncProvider mounted?")
  return _childStores
}

/** Global polling can run before SyncProvider has registered a directory owner. */
export function getOptionalSyncChildStores(): ChildStoreManager | null {
  return _childStores
}

/** Read current directory's child store state. Returns undefined if not bootstrapped. */
export function getDirectoryState(directory?: string): State | undefined {
  const stores = _childStores
  if (!stores) return undefined
  const dir = directory || _directory
  if (!dir) return undefined
  return stores.getState(dir)
}

/** Read resolved OpenCode config from a directory child store, if bootstrapped. */
export function getSyncConfig(directory?: string): Config | undefined {
  const config = getDirectoryState(directory)?.config
  return config && Object.keys(config).length > 0 ? config : undefined
}

export function subscribeToSyncConfigChanges(listener: (directory: string, config: Config) => void): () => void {
  configListeners.add(listener)
  return () => {
    configListeners.delete(listener)
  }
}

export function emitSyncConfigChanged(directory: string, config: Config): void {
  if (!directory) return
  for (const listener of configListeners) {
    listener(directory, config)
  }
}

/** Read sessions from current directory's child store */
export function getSyncSessions(directory?: string) {
  return getDirectoryState(directory)?.session ?? []
}

/** Read sessions across all initialized child stores */
export function getAllSyncSessions() {
  return Array.from(getAllSyncSessionMap().values())
}

/** Read the cached cross-directory session index, rebuilding only when a session slice changes. */
export function getAllSyncSessionMap(): ReadonlyMap<string, State["session"][number]> {
  const stores = _childStores
  if (!stores) return cachedSessionsById

  let changed = cachedSessionManager !== stores || cachedSessionSlices.size !== stores.children.size
  for (const [directory, store] of stores.children) {
    if (cachedSessionSlices.get(directory) !== store.getState().session) {
      changed = true
      break
    }
  }
  if (!changed) return cachedSessionsById

  const nextSlices = new Map<string, State["session"]>()
  const nextSessionsById = new Map<string, State["session"][number]>()
  const nextDirectoriesById = new Map<string, string>()
  const displaced = new Map<string, { directory: string; session: State["session"][number] }>()
  for (const [directory, store] of stores.children) {
    const sessions = store.getState().session
    nextSlices.set(directory, sessions)
    for (const session of sessions) {
      if (!session?.id) continue
      const replaced = nextSessionsById.get(session.id)
      if (replaced) displaced.set(session.id, { directory: nextDirectoriesById.get(session.id)!, session: replaced })
      nextSessionsById.set(session.id, session)
      nextDirectoriesById.set(session.id, directory)
    }
  }
  for (const [id, earlier] of displaced) {
    const session = nextSessionsById.get(id)!
    const directory = nextDirectoriesById.get(id)!
    const previous = cachedSessionsById.get(id)
    // Rebuilding on streaming metadata must not turn duplicate sidebar entries
    // into per-token log traffic. Record changes to the winner's routing/model.
    if (previous && cachedSessionDirectoryById.get(id) === directory && previous.directory === session.directory
      && previous.model?.providerID === session.model?.providerID && previous.model?.id === session.model?.id && previous.model?.variant === session.model?.variant) continue
    recordSessionRouting({ action: "index-replace", source: "send-index", sessionId: id, directory, ownerDirectory: session.directory,
      previousDirectory: earlier.directory, model: session.model, previousModel: earlier.session.model,
      updated: session.time?.updated, previousUpdated: earlier.session.time?.updated })
  }
  cachedSessionManager = stores
  cachedSessionSlices = nextSlices
  cachedSessionsById = nextSessionsById
  cachedSessionDirectoryById = nextDirectoriesById
  return cachedSessionsById
}

/**
 * Directory of a child store that holds this session.
 *
 * This reports containment, not ownership, and a session can be held by more
 * than one store: a project's session list includes the sessions of its
 * worktrees so the sidebar can group them, so the parent repository holds
 * worktree sessions too. Ownership comes from the session record's own
 * directory; this is the fallback for a record that carries none. Returns
 * `null` when no initialized child store contains the session, which means
 * "unknown", never "no directory".
 */
export function getSyncSessionDirectory(sessionId: string): string | null {
  if (!sessionId) return null
  getAllSyncSessionMap()
  return cachedSessionDirectoryById.get(sessionId) ?? null
}

/** Read messages for a session from current directory's child store */
export function getSyncMessages(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.message[sessionId] ?? []
}

/** Read renderability of a session snapshot from current directory's child store */
export function getSyncSessionMaterializationStatus(sessionId: string, directory?: string) {
  const state = getDirectoryState(directory)
  if (!state) return { hasMessages: false, renderable: false, missingPartMessageIDs: [] }
  return getSessionMaterializationStatus(state, sessionId)
}

/** Read parts for a message from current directory's child store */
export function getSyncParts(messageId: string, directory?: string) {
  return getDirectoryState(directory)?.part[messageId] ?? []
}

/** Read session status from current directory's child store */
export function getSyncSessionStatus(sessionId: string, directory?: string) {
  return getDirectoryState(directory)?.session_status[sessionId]
}
