import type { Session } from '@/lib/opencode/model';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { hasActiveSubagent, useGlobalSessionStatusStore } from './global-session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';

type OperatorChildrenDoneChoice = 'stop' | 'finish' | 'cancel';

type PendingQuestion = {
  titles: readonly string[];
  resolve: (choice: OperatorChildrenDoneChoice) => void;
};

let pending: PendingQuestion | null = null;
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) listener();
};

export const getOperatorChildrenDoneQuestion = (): PendingQuestion | null => pending;

export const subscribeOperatorChildrenDoneQuestion = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const answerOperatorChildrenDoneQuestion = (choice: OperatorChildrenDoneChoice): void => {
  const question = pending;
  pending = null;
  emitChange();
  question?.resolve(choice);
};

const ask = (titles: readonly string[]): Promise<OperatorChildrenDoneChoice> => {
  pending?.resolve('cancel');
  return new Promise((resolve) => {
    pending = { titles, resolve };
    emitChange();
  });
};

const childrenByParent = (sessions: readonly Session[]): Map<string, Session[]> => {
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const siblings = children.get(session.parentID);
    if (siblings) siblings.push(session);
    else children.set(session.parentID, [session]);
  }
  return children;
};

const collectSubtree = (rootId: string, children: Map<string, Session[]>): Session[] => {
  const found: Session[] = [];
  const stack = [...(children.get(rootId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const session = stack.pop();
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    found.push(session);
    stack.push(...(children.get(session.id) ?? []));
  }
  return found;
};

export const findRunningOperatorChildren = (
  rootIds: readonly string[],
  sessions: readonly Session[],
  activeSessionIds: ReadonlySet<string>,
): Session[] => {
  const children = childrenByParent(sessions);
  const parentOf = (id: string) => sessions.find((session) => session.id === id)?.parentID;
  const running = new Map<string, Session>();
  for (const rootId of rootIds) {
    for (const session of collectSubtree(rootId, children)) {
      if (!isOperatorChildSession(session)) continue;
      if (activeSessionIds.has(session.id) || hasActiveSubagent(session.id, activeSessionIds, parentOf)) running.set(session.id, session);
    }
  }
  return [...running.values()];
};

const ownedSessions = (rootIds: readonly string[], sessions: readonly Session[]): Session[] => {
  const children = childrenByParent(sessions);
  const owned = new Map<string, Session>();
  for (const root of rootIds) {
    for (const worker of collectSubtree(root, children).filter(isOperatorChildSession)) {
      owned.set(worker.id, worker);
      for (const child of collectSubtree(worker.id, children)) owned.set(child.id, child);
    }
  }
  return [...owned.values()];
};

const readCommands = async (sessions: readonly Session[]) => {
  const owners = new Map(sessions.map((session) => [session.id, session]));
  const scopes = new Map(sessions.map((session) => [spaceIdOfDirectory(session.directory), session.directory]));
  return (await Promise.all([...scopes].map(async ([space, directory]) => {
    const client = space && directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient();
    return (await client.session.exec.list()).filter((command) => owners.has(command.sessionID)
      && spaceIdOfDirectory(owners.get(command.sessionID)?.directory) === space);
  }))).flat();
};

export const settleRunningOperatorChildren = async (rootIds: readonly string[]): Promise<boolean> => {
  const runtimeKey = getRuntimeKey();
  const sessions = () => useGlobalSessionsStore.getState().activeSessions;
  const active = () => useGlobalSessionStatusStore.getState().activeSessionIds;
  const scope = ownedSessions(rootIds, sessions());
  if (scope.length === 0) return true;
  const commands = await readCommands(scope);
  if (runtimeKey !== getRuntimeKey()) return false;
  const running = findRunningOperatorChildren(rootIds, sessions(), new Set([...active(), ...commands.map((command) => command.sessionID)]));
  if (!running.length) return true;
  const choice = await ask(running.map((session) => session.title));
  if (choice === 'cancel' || getRuntimeKey() !== runtimeKey) return false;
  if (choice === 'stop') {
    const live = await readCommands(ownedSessions(rootIds, sessions()));
    if (getRuntimeKey() !== runtimeKey) return false;
    await Promise.all(ownedSessions(rootIds, sessions()).map(async (session) => {
      if (active().has(session.id)) return opencodeClient.stopSession(session.id, session.directory);
      const execIDs = live.filter((command) => command.sessionID === session.id).map((command) => command.execID);
      if (!execIDs.length) return;
      const client = session.directory ? opencodeClient.getScopedSdkClient(session.directory) : opencodeClient.getSdkClient();
      const result = await client.session.exec.stop({ sessionID: session.id, execIDs });
      if (result.failed > 0) throw new Error(`Failed to stop ${result.failed} commands in ${session.title}`);
    }));
  }
  return getRuntimeKey() === runtimeKey;
};
