import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { useAllLiveSessions } from '@/sync/sync-context';
import {
  compareSessionsByLifecycleOrder,
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { deriveRecentSessions } from '../recent/activitySections';
import { normalizePath } from '../utils';

type ProjectSidebarActiveSessionsArgs = {
  globalActiveSessions: Session[];
  liveSessions: Session[];
  knownDirectories: Set<string>;
  isVSCode: boolean;
};

const EMPTY_ACTIVE_SESSION_IDS: ReadonlySet<string> = new Set();

const isKnownActiveSessionDirectory = (
  session: Session,
  knownDirectories: Set<string>,
  isVSCode: boolean,
): boolean => {
  if (session.time?.archived) return true;
  const directory = normalizePath(resolveGlobalSessionDirectory(session))?.toLowerCase();
  if (!directory) return !isVSCode;
  if (knownDirectories.size === 0) return !isVSCode;
  return knownDirectories.has(directory);
};

// Global sessions provide complete sidebar coverage; initialized directory
// stores only fill gaps until the global cache catches up.
export const projectSidebarActiveSessions = ({
  globalActiveSessions,
  liveSessions,
  knownDirectories,
  isVSCode,
}: ProjectSidebarActiveSessionsArgs): Session[] => {
  const sessions = [...globalActiveSessions];
  const knownIds = new Set(globalActiveSessions.map((session) => session.id));

  for (const session of liveSessions) {
    if (knownIds.has(session.id)) continue;
    sessions.push(session);
  }

  return sessions.filter((session) => isKnownActiveSessionDirectory(session, knownDirectories, isVSCode));
};

export const projectSidebarCollection = (args: ProjectSidebarActiveSessionsArgs): Session[] => {
  return projectSidebarActiveSessions(args);
};

// The collection owns hierarchy membership. Consumers receive this narrow
// resolver instead of retaining the collection's mutable indexing detail.
export const getDescendantIds = (
  childrenMap: ReadonlyMap<string, readonly Session[]>,
  sessionId: string,
): string[] => {
  const descendants: string[] = [];
  const visited = new Set<string>([sessionId]);
  const visit = (parentId: string): void => {
    for (const child of childrenMap.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      descendants.push(child.id);
      visit(child.id);
    }
  };
  visit(sessionId);
  return descendants;
};

type UseSessionProjectCollectionArgs = {
  knownDirectories: Set<string>;
  isVSCode: boolean;
  isVisible: boolean;
};

// The collection owns the global-first/live-gap merge and lifecycle ordering.
// Selection state intentionally never enters this boundary: rows subscribe to
// active state themselves, leaving this projection referentially stable.
export const useSessionProjectCollection = ({
  knownDirectories,
  isVSCode,
  isVisible,
}: UseSessionProjectCollectionArgs) => {
  const globalActiveSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const hasAuthoritativeGlobalSessions = useGlobalSessionsStore((state) => state.status === 'ready');
  const liveSessions = useAllLiveSessions();
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isVisible ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isVisible],
  ));
  const sessions = React.useMemo(() => projectSidebarCollection({
    globalActiveSessions,
    liveSessions,
    knownDirectories,
    isVSCode,
  }), [globalActiveSessions, isVSCode, knownDirectories, liveSessions]);
  const orderedSessions = React.useMemo(
    () => orderSessionsByLifecycleScopes(sessions, pinnedSessionIds, sessionOrderRanks),
    [pinnedSessionIds, sessionOrderRanks, sessions],
  );
  const sessionById = React.useMemo(() => new Map(
    [...orderedSessions, ...archivedSessions].map((session) => [session.id, session]),
  ), [archivedSessions, orderedSessions]);
  const childrenMap = React.useMemo(() => {
    const children = new Map<string, Session[]>();
    for (const session of sessionById.values()) {
      // SAFETY: OpenCode's session records carry parentID for sub-session
      // hierarchy; the SDK's base Session type does not currently expose it.
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) continue;
      const siblings = children.get(parentID) ?? [];
      siblings.push(session);
      children.set(parentID, siblings);
    }
    return children;
  }, [sessionById]);
  const getDescendantIdsForAction = React.useCallback(
    (sessionId: string, options: { includeArchived: boolean }) => getDescendantIds(childrenMap, sessionId)
      .filter((id) => options.includeArchived || !Boolean(sessionById.get(id)?.time?.archived)),
    [childrenMap, sessionById],
  );

  return {
    archivedSessions,
    childrenMap,
    getDescendantIds: getDescendantIdsForAction,
    globalActiveSessions,
    hasAuthoritativeGlobalSessions,
    liveSessions,
    orderedSessions,
    pinnedSessionIds,
    sessionOrderRanks,
    sessions,
  };
};

type UseRecentSessionCollectionArgs = {
  enabled: boolean;
  isVSCode: boolean;
  pinnedSessionIds: Set<string>;
  sessionOrderRanks: ReadonlyMap<string, number>;
  sessions: Session[];
};

// Recent is a separate high-frequency collection view. Its active membership
// never participates in project ownership or project section projection.
export const useRecentSessionCollection = ({
  enabled,
  isVSCode,
  pinnedSessionIds,
  sessionOrderRanks,
  sessions,
}: UseRecentSessionCollectionArgs): Session[] => {
  const activeSessionIdSet = useGlobalSessionStatusStore(
    React.useCallback(
      (state) => enabled && !isVSCode ? state.activeSessionIds : EMPTY_ACTIVE_SESSION_IDS,
      [enabled, isVSCode],
    ),
  );

  return React.useMemo(() => {
    if (!enabled || isVSCode) return [];
    return deriveRecentSessions(sessions, activeSessionIdSet)
      .sort((left, right) => compareSessionsByLifecycleOrder(left, right, pinnedSessionIds, sessionOrderRanks));
  }, [activeSessionIdSet, enabled, isVSCode, pinnedSessionIds, sessionOrderRanks, sessions]);
};
