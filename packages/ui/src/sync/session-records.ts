import type { PermissionRuleset, Session, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { Binary } from "./binary"

function areMetadataEqual(left: Session["metadata"], right: Session["metadata"]): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
}

function optionalEqual<T>(
  left: T | undefined,
  right: T | undefined,
  equal: (left: T, right: T) => boolean,
): boolean {
  return left === right || (left !== undefined && right !== undefined && equal(left, right))
}

const diffsEqual = (left: SnapshotFileDiff[], right: SnapshotFileDiff[]) => (
  left.length === right.length
  && left.every((item, index) => {
    const candidate = right[index]
    return item.file === candidate.file
      && item.patch === candidate.patch
      && item.additions === candidate.additions
      && item.deletions === candidate.deletions
      && item.status === candidate.status
  })
)

const permissionsEqual = (left: PermissionRuleset, right: PermissionRuleset) => (
  left.length === right.length
  && left.every((item, index) => {
    const candidate = right[index]
    return item.permission === candidate.permission
      && item.pattern === candidate.pattern
      && item.action === candidate.action
  })
)

function areSessionsEqual(left: Session, right: Session): boolean {
  return left.id === right.id
    && left.slug === right.slug
    && left.projectID === right.projectID
    && left.workspaceID === right.workspaceID
    && left.directory === right.directory
    && left.path === right.path
    && left.parentID === right.parentID
    && left.cost === right.cost
    && left.title === right.title
    && left.agent === right.agent
    && left.version === right.version
    && areMetadataEqual(left.metadata, right.metadata)
    && optionalEqual(left.summary, right.summary, (a, b) => (
      a.additions === b.additions
      && a.deletions === b.deletions
      && a.files === b.files
      && optionalEqual(a.diffs, b.diffs, diffsEqual)
    ))
    && optionalEqual(left.tokens, right.tokens, (a, b) => (
      a.input === b.input
      && a.output === b.output
      && a.reasoning === b.reasoning
      && a.cache.read === b.cache.read
      && a.cache.write === b.cache.write
    ))
    && optionalEqual(left.share, right.share, (a, b) => a.url === b.url)
    && optionalEqual(left.model, right.model, (a, b) => (
      a.id === b.id
      && a.providerID === b.providerID
      && a.variant === b.variant
    ))
    && left.time.created === right.time.created
    && left.time.updated === right.time.updated
    && left.time.compacting === right.time.compacting
    && left.time.archived === right.time.archived
    && optionalEqual(left.permission, right.permission, permissionsEqual)
    && optionalEqual(left.revert, right.revert, (a, b) => (
      a.messageID === b.messageID
      && a.partID === b.partID
      && a.snapshot === b.snapshot
      && a.diff === b.diff
    ))
}

export function upsertSessionRecord(current: Session[], incoming: Session): Session[] {
  const result = Binary.search(current, incoming.id, (session) => session.id)
  if (!result.found) return [...current.slice(0, result.index), incoming, ...current.slice(result.index)]
  // Equivalent authoritative detail must retain sidebar session-list references.
  if (areSessionsEqual(current[result.index], incoming)) return current
  const next = [...current]
  next[result.index] = incoming
  return next
}
