import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { selectCatalogLoadedForDirectory, selectConfigAgentsForDirectory, useConfigStore } from "@/stores/useConfigStore"
import { getAllSyncSessions, getDirectoryState, getSyncSessionDirectory } from "./sync-refs"
import { recordSessionRouting, reportModelCacheMismatch } from "@/lib/diagnostics/session-routing"

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

/**
 * Check the requested agent against the server, then compare the model with
 * the latest cache. Model updates received during the read remain visible.
 */
export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  let agentChanged = false
  let currentSession: Session | undefined
  if (desired.agent) {
    const isCurrentRuntime = captureRuntimeInstance()
    try {
      currentSession = await opencodeClient.getSession(sessionId, directory)
    } catch (error) {
      // The prompt has not left, so a failed read needs no send confirmation.
      if (error instanceof Error) markDefiniteTransportFailure(error)
      throw error
    }
    if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
    agentChanged = currentSession.agent !== desired.agent
  }
  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const modelChanged = !session?.model || !isSameModelRef(session.model, model)
  recordSessionRouting({ action: "send-selection", source: "send", sessionId, directory, ownerDirectory: currentSession?.directory,
    model, previousModel: currentSession?.model, cachedModel: session?.model, updated: currentSession?.time?.updated, outcome: modelChanged ? "switch" : "unchanged" })
  // Diagnostics reuse the agent read, never add a read or change selection.
  if (currentSession) {
    const indexedDirectory = getSyncSessionDirectory(sessionId)
    const indexed = indexedDirectory === directory ? session : getDirectoryState(indexedDirectory ?? undefined)?.session.find((candidate) => candidate.id === sessionId)
    const cached = [session?.model, indexed?.model].filter((value) => value !== undefined)
    const serverChanged = !currentSession.model || !isSameModelRef(currentSession.model, model)
    const suppressed = serverChanged && cached.some((value) => isSameModelRef(value, model))
    const consistent = cached.every((value) => currentSession.model && isSameModelRef(value, currentSession.model))
    reportModelCacheMismatch({ sessionId, directory, ownerDirectory: currentSession.directory, previousDirectory: indexedDirectory,
      model, previousModel: currentSession.model, cachedModel: indexed?.model ?? session?.model }, suppressed, consistent)
  }
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}

/**
 * `resolveSendSelection`, plus the agent the client still has to check. The
 * session can already be on an agent its folder lacks: set before the client
 * checked it, or its file was removed since. When the folder's loaded catalog
 * does not list it, the agent stays in the selection, so the client checks it
 * against a fresh list before anything is switched.
 */
export async function resolveCheckedSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  const selection = await resolveSendSelection(sessionId, directory, desired)
  if (selection.agent || !desired.agent || !directory) return selection
  const config = useConfigStore.getState()
  const listed = !selectCatalogLoadedForDirectory(config, "agents", directory)
    || selectConfigAgentsForDirectory(config, directory).some((agent) => agent.id === desired.agent)
  return listed ? selection : { ...selection, agent: desired.agent }
}
