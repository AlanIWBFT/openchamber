import React from 'react';
import type { Message, SessionStatus } from '@opencode-ai/sdk/v2/client';
import { useSessionUIStore } from '@/sync/session-ui-store';
import {
  useDirectorySync,
  useSessionMessages,
  useSessionPermissions,
  useSessionQuestions,
  useSessionStatus,
} from '@/sync/sync-context';

// Mirrors OpenCode SessionStatus: busy|retry|idle.
type SessionActivityPhase = 'idle' | 'busy' | 'retry';

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
  lastMessage: Message | undefined;
  fallbackExpired: boolean;
  hasBlockingRequest: boolean;
};

function hasPendingAssistant(message: Message | undefined): boolean {
  return Boolean(
    message
    && message.role === 'assistant'
    && typeof (message as { time?: { completed?: number } }).time?.completed !== 'number',
  );
}

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
    || !hasPendingAssistant(input.lastMessage)
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
    && hasPendingAssistant(input.lastMessage),
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
    lastMessage: input.lastMessage,
    fallbackExpired,
    hasBlockingRequest: input.hasBlockingRequest,
  }), [
    fallbackExpired,
    input.hasBlockingRequest,
    input.lastMessage,
    input.status,
    input.statusSnapshotReady,
  ]);
}

/**
 * Determines if a session is actively working.
 * Uses live session_status whenever it is available. An unfinished assistant
 * message is only a bounded fallback while the initial live snapshot is unresolved.
 * Returns idle when permissions or questions are pending (the permission /
 * question indicator takes priority, and the send button must stay available so
 * the user can supersede the prompt with a new message).
 */
function useSessionActivity(sessionId: string | null | undefined, directory?: string): SessionActivityResult {
  const status = useSessionStatus(sessionId ?? '', directory);
  const statusSnapshotReady = useDirectorySync(
    React.useCallback((state) => state.session_status_ready, []),
    directory,
  );
  const fallbackUntil = useDirectorySync(
    React.useCallback((state) => state.session_status_fallback_until, []),
    directory,
  );
  const messages = useSessionMessages(sessionId ?? '', directory);
  const permissions = useSessionPermissions(sessionId ?? '', directory);
  const questions = useSessionQuestions(sessionId ?? '', directory);
  const lastMessage = messages[messages.length - 1];

  return useResolvedSessionActivity({
    sessionId,
    status,
    statusSnapshotReady,
    fallbackUntil,
    lastMessage,
    hasBlockingRequest: !sessionId || permissions.length > 0 || questions.length > 0,
  });
}

export function useCurrentSessionActivity(): SessionActivityResult {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  return useSessionActivity(currentSessionId, currentSessionDirectory ?? undefined);
}
