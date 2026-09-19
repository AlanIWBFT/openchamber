import type { StoreApi } from "zustand"
import { readDirectoryFormSnapshot, readDirectoryPermissionSnapshot } from "./directory-recovery-snapshots"
import { applyGlobalBlockingRequestSnapshot } from "./global-blocking-requests"
import { isVSCodeRuntime } from "@/lib/desktop"
import { ChildStoreManager, type DirectoryStore } from "./child-store"
import { noteQuestionFormSnapshot } from "./recoverable-questions"
import { opencodeClient } from "@/lib/opencode/client"
import { processVSCodeReconciledPermissionAutoAccept } from "./vscode-permission-auto-accept"
import { toast } from "@/components/ui"
import { showPermissionNeededToast } from "./permission-toast"
import { captureRuntimeInstance } from "@/lib/runtime-switch"
import { isViewedInCurrentSession } from "./viewed-sessions"
import { getFormToastKey, pendingFormToastIds, FORM_TOAST_DESCRIPTION, formToastAction, pendingPermissionToastIds, openRequestFromToast } from "./sync-request-notifications"

export async function resyncBlockingRequestsForDirectory(
  directory: string,
  store: StoreApi<DirectoryStore>,
  candidateSessionIds?: string[],
  options?: { includePermissions?: boolean; isStale?: () => boolean },
) {
  const isCurrentRuntime = captureRuntimeInstance()
  const sdk = opencodeClient.getSdkClient()
  const isStale = () => !isCurrentRuntime() || sdk !== opencodeClient.getSdkClient() || options?.isStale?.() === true
  if (isStale()) return false
  const before = store.getState()
  const candidateIds = new Set<string>(candidateSessionIds ?? [
    ...before.session.map((session) => session.id),
    ...Object.keys(before.message ?? {}),
    ...Object.keys(before.session_status ?? {}),
    ...Object.keys(before.form ?? {}),
    ...Object.keys(before.permission ?? {}),
  ])
  if (candidateIds.size === 0) return true
  const candidates = Array.from(candidateIds)
  let succeeded = true

  // Re-fetch pending forms that may have been asked during an SSE gap,
  // reconnect window, or directory materialization gap.
  try {
    const grouped = await readDirectoryFormSnapshot(store, () => opencodeClient.listPendingForms({ directories: [directory], includeGlobal: false }), {
      sessionIDs: candidates,
      isStale,
      commit: (form) => {
        store.setState({ form })
        applyGlobalBlockingRequestSnapshot(directory, { kind: "forms", groups: form }, candidates)
        noteQuestionFormSnapshot(directory, Object.values(form).flat())
      },
    })
    if (isStale()) return false

    for (const [sessionId, forms] of Object.entries(grouped)) {
      if (!candidateIds.has(sessionId)) continue
      const knownIds = new Set((before.form[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const form of forms) {
        if (knownIds.has(form.id)) continue
        const toastKey = getFormToastKey(sessionId, form.id)
        if (!toastKey || pendingFormToastIds.has(toastKey)) continue
        pendingFormToastIds.add(toastKey)
        toast.info(form.title, {
          id: `form-${toastKey}`,
          description: FORM_TOAST_DESCRIPTION,
          action: formToastAction(sessionId, directory, form.id),
        })
      }
    }

  } catch {
    // Non-fatal: form resync best-effort
    succeeded = false
  }

  if (isStale()) return false
  if (options?.includePermissions === false) return succeeded

  // Re-fetch pending permissions — same rationale as forms.
  try {
    const grouped = await readDirectoryPermissionSnapshot(store, () => opencodeClient.listPendingPermissions({ directories: [directory], includeGlobal: false }), {
      sessionIDs: candidates,
      isStale,
      settle: isVSCodeRuntime() ? async (permissions) => {
        const accepted = new Set<string>()
        await Promise.all(permissions.filter((permission) => candidateIds.has(permission.sessionID)).map(async (permission) => {
          if (await processVSCodeReconciledPermissionAutoAccept(permission, directory)) accepted.add(permission.id)
        }))
        return accepted
      } : undefined,
      commit: (permission) => {
        store.setState({ permission })
        applyGlobalBlockingRequestSnapshot(directory, { kind: "permissions", groups: permission }, candidates)
      },
    })
    if (isStale()) return false

    for (const [sessionId, permissions] of Object.entries(grouped)) {
      if (!candidateIds.has(sessionId)) continue
      const knownIds = new Set((before.permission[sessionId] ?? []).map((item) => item.id))
      const isViewed = isViewedInCurrentSession(directory, sessionId)
      if (isViewed) continue
      for (const permission of permissions) {
        if (knownIds.has(permission.id)) continue
        showPermissionNeededToast({
          permission,
          directory,
          isViewed,
          pendingIds: pendingPermissionToastIds,
          show: (title, options) => toast.info(title, options),
          openSession: openRequestFromToast,
        })
      }
    }

  } catch {
    // Non-fatal: permission resync best-effort
    succeeded = false
  }
  return succeeded
}

export async function resyncBlockingRequestsForActiveDirectory(
  directory: string,
  childStores: ChildStoreManager,
) {
  const store = childStores.getChild(directory)
  if (!store) return
  await resyncBlockingRequestsForDirectory(directory, store, undefined, { isStale: () => childStores.getChild(directory) !== store })
}
