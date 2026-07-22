import React from 'react';
import { getLastConversationMessage, isIncompleteAssistantTurn, type Message, type SessionStatus } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { formTurnHold, useRecoverableQuestionsStore } from '@/sync/recoverable-questions';
import { readUnloadedFormToolLinks } from '@/sync/session-actions';
import { useDirectorySync, useSessionStatus, useSessionStatusSnapshotReady, useSessionMessagesSelector, useSessionPermissions } from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

const selectHasPendingAssistant = (messages: Message[]): boolean => (
  isIncompleteAssistantTurn(getLastConversationMessage(messages))
);

export interface SessionActivityResult {
  phase: SessionActivityPhase;
  isWorking: boolean;
  isBusy: boolean;
  isCooldown: boolean;
}

const IDLE_RESULT: SessionActivityResult = {
  phase: 'idle',
  isWorking: false,
  isBusy: false,
  isCooldown: false,
};

type SessionActivityInput = {
  status: SessionStatus | undefined;
  statusSnapshotReady: boolean;
  hasPendingAssistant: boolean;
  fallbackExpired: boolean;
  hasBlockingRequest: boolean;
};

export function getSessionActivity(input: SessionActivityInput): SessionActivityResult {
  if (input.hasBlockingRequest) return IDLE_RESULT;

  if (input.status && input.status.type !== 'idle') {
    return {
      phase: input.status.type,
      isWorking: true,
      isBusy: input.status.type === 'busy',
      isCooldown: false,
    };
  }

  if (
    input.status?.type === 'idle'
    || input.statusSnapshotReady
    || input.fallbackExpired
    || !input.hasPendingAssistant
  ) {
    return IDLE_RESULT;
  }

  return { phase: 'busy', isWorking: true, isBusy: true, isCooldown: false };
}

export function useResolvedSessionActivity(input: Omit<SessionActivityInput, 'fallbackExpired'> & {
  sessionId: string | null | undefined;
  fallbackUntil: number;
}): SessionActivityResult {
  const fallbackCandidate = Boolean(
    input.sessionId
    && !input.status
    && !input.statusSnapshotReady
    && input.hasPendingAssistant,
  );
  const [fallbackClock, setFallbackClock] = React.useState(Date.now);
  const fallbackExpired = Math.max(fallbackClock, Date.now()) >= input.fallbackUntil;

  React.useEffect(() => {
    if (!fallbackCandidate || fallbackExpired) return;

    const timer = setTimeout(() => {
      setFallbackClock(Date.now());
    }, Math.max(0, input.fallbackUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [fallbackCandidate, fallbackExpired, input.fallbackUntil]);

  return React.useMemo(() => getSessionActivity({
    status: input.status,
    statusSnapshotReady: input.statusSnapshotReady,
    hasPendingAssistant: input.hasPendingAssistant,
    fallbackExpired,
    hasBlockingRequest: input.hasBlockingRequest,
  }), [
    fallbackExpired,
    input.hasBlockingRequest,
    input.hasPendingAssistant,
    input.status,
    input.statusSnapshotReady,
  ]);
}

/**
 * Determines if a session is actively working.
 * Uses live session_status whenever it is available. An unfinished assistant
 * message is only a bounded fallback while the initial live snapshot is unresolved.
 * Returns idle when a permission or a form that holds the turn is pending (the
 * permission / form indicator takes priority, and the send button must stay
 * available so the user can supersede the prompt with a new message). A form
 * whose tool call has ended holds nothing, so a running turn keeps Stop and
 * Queue (#5391).
 */
export function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusSnapshotReady = useSessionStatusSnapshotReady(directory, sessionId ?? '');
  const fallbackUntil = useDirectorySync(
    React.useCallback((state) => state.session_status_fallback_until, []),
    directory,
  );
  const hasPendingAssistant = useSessionMessagesSelector(sessionId ?? '', directory, selectHasPendingAssistant);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const releasedForms = useRecoverableQuestionsStore((state) => state.releasedForms);
  const formHoldsTurn = useDirectorySync(React.useCallback((state) => (
    state.form[sessionId ?? '']?.some((form) => formTurnHold(form, state.part, releasedForms) !== 'released') ?? false
  ), [sessionId, releasedForms]), directory);
  // Forms linked into history not loaded here: read them now, so the phase is right before the user sends.
  const unloadedForms = useDirectorySync(React.useCallback((state) => (
    (state.form[sessionId ?? ''] ?? [])
      .filter((form) => formTurnHold(form, state.part, releasedForms) === 'unknown')
      .map((form) => form.id)
      .join('\n')
  ), [sessionId, releasedForms]), directory);
  // A refresh of the forms (reconnect, materialization) is a new array: a read that failed is retried then, not in a loop.
  const sessionForms = useDirectorySync(React.useCallback((state) => state.form[sessionId ?? ''], [sessionId]), directory);
  React.useEffect(() => {
    if (sessionId && unloadedForms) readUnloadedFormToolLinks(sessionId);
  }, [sessionId, unloadedForms, sessionForms]);

  return useResolvedSessionActivity({
    sessionId,
    status,
    statusSnapshotReady,
    fallbackUntil,
    hasPendingAssistant,
    hasBlockingRequest: !sessionId || permissions.length > 0 || formHoldsTurn,
  });
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
