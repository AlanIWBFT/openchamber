import { create } from 'zustand';
import type { Event } from '@opencode-ai/sdk/v2/client';
import { normalizeProjectPath } from '@/lib/projectResolution';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';

// Cross-directory index of permission and question requests still waiting
// for an answer. Directory stores remain the source for open directories;
// this index exists for the ones that are never bootstrapped, whose pending
// requests would otherwise be invisible to the tray and to any surface that
// does not mount a row for them.
//
// It is fed by the same rare events the directory reducer consumes
// (`permission.asked`/`permission.replied`, `question.asked`/`question.replied`/
// `question.rejected`, `session.deleted`) and targeted authoritative snapshots.
// Consumers subscribe per session ID without observing token-stream events.

export type PendingBlockingRequests = {
  directory: string;
  permissions: readonly PermissionRequest[];
  questions: readonly QuestionRequest[];
};

type GlobalBlockingRequestsState = {
  bySession: ReadonlyMap<string, PendingBlockingRequests>;
};

const EMPTY: readonly never[] = [];

export const useGlobalBlockingRequestsStore = create<GlobalBlockingRequestsState>(() => ({
  bySession: new Map(),
}));

export const resetGlobalBlockingRequests = (): void => {
  useGlobalBlockingRequestsStore.setState({ bySession: new Map() });
};

const normalizeDirectory = (directory: string): string => normalizeProjectPath(directory) ?? directory;

/** Returns the list with the request added or replaced, or null when nothing changed. */
const upsertRequest = <T extends { id: string }>(list: readonly T[], request: T): readonly T[] | null => {
  const index = list.findIndex((entry) => entry.id === request.id);
  if (index === -1) return [...list, request];
  if (list[index] === request) return null;
  const next = [...list];
  next[index] = request;
  return next;
};

/** Returns the list without the request, or null when nothing changed. A missing id settles the whole kind. */
const withoutRequest = <T extends { id: string }>(list: readonly T[], requestId: string | undefined): readonly T[] | null => {
  if (!requestId) return list.length === 0 ? null : EMPTY;
  const next = list.filter((entry) => entry.id !== requestId);
  return next.length === list.length ? null : next;
};

type Draft = Map<string, PendingBlockingRequests>;

class Reducer {
  private draft: Draft | null = null;

  constructor(private readonly state: GlobalBlockingRequestsState) {}

  current(sessionId: string): PendingBlockingRequests | undefined {
    return (this.draft ?? this.state.bySession).get(sessionId);
  }

  write(sessionId: string, entry: PendingBlockingRequests): void {
    this.draft ??= new Map(this.state.bySession);
    if (entry.permissions.length === 0 && entry.questions.length === 0) this.draft.delete(sessionId);
    else this.draft.set(sessionId, entry);
  }

  ask(directory: string, sessionId: string, request: PermissionRequest | null, question: QuestionRequest | null): void {
    const existing = this.current(sessionId) ?? { directory, permissions: EMPTY, questions: EMPTY };
    const permissions = request ? upsertRequest(existing.permissions, request) : null;
    const questions = question ? upsertRequest(existing.questions, question) : null;
    if (!permissions && !questions && existing.directory === directory) return;
    this.write(sessionId, {
      directory,
      permissions: permissions ?? existing.permissions,
      questions: questions ?? existing.questions,
    });
  }

  settle(kind: 'permissions' | 'questions', sessionId: string, requestId: string | undefined): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    if (kind === 'permissions') {
      const permissions = withoutRequest(existing.permissions, requestId);
      if (permissions) this.write(sessionId, { ...existing, permissions });
      return;
    }
    const questions = withoutRequest(existing.questions, requestId);
    if (questions) this.write(sessionId, { ...existing, questions });
  }

  remove(sessionId: string): void {
    const existing = this.current(sessionId);
    if (!existing) return;
    this.write(sessionId, { ...existing, permissions: EMPTY, questions: EMPTY });
  }

  publish(): void {
    if (this.draft) useGlobalBlockingRequestsStore.setState({ bySession: this.draft });
  }
}

/** Applies request lifecycle events for one directory. Other event types are ignored cheaply. */
export const applyGlobalBlockingRequestEvents = (rawDirectory: string, payloads: readonly Event[]): void => {
  if (payloads.length === 0) return;
  const directory = normalizeDirectory(rawDirectory);
  const reducer = new Reducer(useGlobalBlockingRequestsStore.getState());

  for (const payload of payloads) {
    switch (payload.type) {
      case 'permission.asked': {
        // SAFETY: the ask event carries the full permission request as its properties, the same contract the directory reducer relies on.
        const request = payload.properties as PermissionRequest;
        if (request.sessionID && request.id) reducer.ask(directory, request.sessionID, request, null);
        continue;
      }
      case 'question.asked': {
        // SAFETY: the ask event carries the full question request as its properties, the same contract the directory reducer relies on.
        const request = payload.properties as QuestionRequest;
        if (request.sessionID && request.id) reducer.ask(directory, request.sessionID, null, request);
        continue;
      }
      case 'permission.replied':
      case 'question.replied':
      case 'question.rejected': {
        // SAFETY: reply events name the session and, when OpenCode includes it, the request they settle.
        const props = payload.properties as { sessionID?: string; requestID?: string };
        if (props.sessionID) {
          reducer.settle(payload.type === 'permission.replied' ? 'permissions' : 'questions', props.sessionID, props.requestID);
        }
        continue;
      }
      case 'session.deleted': {
        // SAFETY: deletion event properties identify the deleted session directly or through info.id.
        const props = payload.properties as { sessionID?: string; info?: { id?: string } };
        const sessionId = props.sessionID ?? props.info?.id;
        if (sessionId) reducer.remove(sessionId);
        continue;
      }
      default:
        continue;
    }
  }

  reducer.publish();
};

/** Publish an already event-reconciled, authoritative directory snapshot. */
export const applyGlobalBlockingRequestSnapshot = (
  rawDirectory: string,
  snapshot: { kind: 'permissions'; groups: Record<string, PermissionRequest[]> } | { kind: 'questions'; groups: Record<string, QuestionRequest[]> },
): void => {
  const directory = normalizeDirectory(rawDirectory);
  const state = useGlobalBlockingRequestsStore.getState();
  const reducer = new Reducer(state);
  const ids = new Set(Object.keys(snapshot.groups));
  for (const [id, entry] of state.bySession) if (entry.directory === directory) ids.add(id);
  for (const id of ids) {
    const existing = reducer.current(id) ?? { directory, permissions: EMPTY, questions: EMPTY };
    if (snapshot.kind === 'permissions') {
      reducer.write(id, { ...existing, directory, permissions: snapshot.groups[id] ?? EMPTY });
    } else {
      reducer.write(id, { ...existing, directory, questions: snapshot.groups[id] ?? EMPTY });
    }
  }
  reducer.publish();
};
