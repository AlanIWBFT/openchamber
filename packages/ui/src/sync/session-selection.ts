import { opencodeClient } from "@/lib/opencode/client"
import { isSameModelRef, toModelRef, type ModelRef, type Session } from "@/lib/opencode/model"
import { markDefiniteTransportFailure } from "@/lib/relay/transport-error"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { getAllSyncSessions, getDirectoryState, getSyncSessionDirectory } from "./sync-refs"
import { recordSessionRouting, reportModelCacheMismatch } from "@/lib/diagnostics/session-routing"

type ResolvedSendSelection = {
  model?: ModelRef
  agent?: string
}

/**
 * Compare both selections with a fresh server record. A stale directory copy
 * can already match the picker while the server still runs another model.
 *
 * OpenCode records every switch in the transcript, so a send leaves the agent
 * unset when the server already runs on the desired agent.
 */
export async function resolveSendSelection(
  sessionId: string,
  directory: string | undefined,
  desired: { providerID: string; modelID: string; variant?: string | null; agent?: string },
): Promise<ResolvedSendSelection> {
  const isCurrentRuntime = captureRuntimeInstance()
  let currentSession: Session
  try {
    currentSession = await opencodeClient.getSession(sessionId, directory)
  } catch (error) {
    // The prompt has not left, so a failed read needs no send confirmation.
    if (error instanceof Error) markDefiniteTransportFailure(error)
    throw error
  }
  if (!isCurrentRuntime()) throw new Error("Message was not sent because the runtime changed.")
  const agentChanged = desired.agent !== undefined && currentSession.agent !== desired.agent
  const sessions = getDirectoryState(directory)?.session ?? getAllSyncSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
  // Compared in wire form: an explicit `Default` (null) switches the session
  // off an effort once, then matches the `"default"` OpenCode records for it.
  const model = toModelRef({ providerID: desired.providerID, id: desired.modelID, variant: desired.variant })
  const modelChanged = !currentSession.model || !isSameModelRef(currentSession.model, model)
  // Observe the copy the old send path would have used, even when ownership
  // routing now bypasses it. A repaired send must not hide renewed pollution.
  const indexedDirectory = getSyncSessionDirectory(sessionId)
  const indexed = indexedDirectory === directory ? session : getDirectoryState(indexedDirectory ?? undefined)?.session.find((candidate) => candidate.id === sessionId)
  const cached = [session?.model, indexed?.model].filter((value) => value !== undefined)
  const suppressed = modelChanged && cached.some((value) => isSameModelRef(value, model))
  const consistent = cached.every((value) => currentSession.model && isSameModelRef(value, currentSession.model))
  recordSessionRouting({ action: "send-selection", source: "send", sessionId, directory, ownerDirectory: currentSession.directory,
    model, previousModel: currentSession.model, cachedModel: session?.model, updated: currentSession.time.updated, outcome: modelChanged ? "switch" : "unchanged" })
  reportModelCacheMismatch({ sessionId, directory, ownerDirectory: currentSession.directory, previousDirectory: indexedDirectory,
    model, previousModel: currentSession.model, cachedModel: indexed?.model ?? session?.model }, suppressed, consistent)
  return {
    model: modelChanged ? model : undefined,
    agent: agentChanged ? desired.agent : undefined,
  }
}
