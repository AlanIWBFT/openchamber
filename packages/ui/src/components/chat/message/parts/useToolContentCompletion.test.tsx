import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import type { AssistantMessage, Session, StoredMessage, ToolPart } from '@/lib/opencode/model';
import { ChildStoreManager } from '@/sync/child-store';
import { getSyncSessionDirectory, setSyncRefs } from '@/sync/sync-refs';
import { useToolContentCompletion } from './useToolContentCompletion';

test('tool completion updates the owning transcript when another directory also lists the session', async () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const globals = { window: happyWindow, document: happyWindow.document, navigator: happyWindow.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const session: Session = {
    id: 'ses_completion', directory: 'D:\\git-gc-opt', projectID: 'project', title: 'Completion',
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 },
  };
  const message: AssistantMessage & StoredMessage = {
    id: 'msg_completion', sessionID: session.id, seq: 1, role: 'assistant',
    time: { created: 1, completed: 2 }, agent: 'build', providerID: 'test', modelID: 'test',
  };
  const shell: ToolPart = {
    id: 'call_completion', callID: 'call_completion', sessionID: session.id, messageID: message.id, type: 'tool', tool: 'read',
    state: { status: 'completed', input: {}, output: '', metadata: { openchamberContentShell: { chars: 6 } }, time: { start: 1, end: 2 } },
  };
  const whole: ToolPart = { ...shell, state: { ...shell.state, status: 'completed', output: 'result', metadata: {}, time: { start: 1, end: 2 } } };
  const manager = new ChildStoreManager();
  const owner = manager.ensureChild('D:/git-gc-opt', { bootstrap: false });
  owner.setState({ session: [session], message: { [session.id]: [message] }, part: { [message.id]: [shell] } });
  const other = manager.ensureChild('G:/BitdefenderUpdateAnalysis/Endpoint Security', { bootstrap: false });
  other.setState({ session: [session] });
  setSyncRefs(OpenCode.make({ baseUrl: 'http://localhost' }), manager, 'D:/git-gc-opt');
  expect(getSyncSessionDirectory(session.id)).toBe('G:/BitdefenderUpdateAnalysis/Endpoint Security');
  const fetchMessage = spyOn(opencodeClient, 'getSessionMessage').mockResolvedValue({ info: message, parts: [whole] });
  const container = document.createElement('div');
  const root = createRoot(container);
  function Result() {
    const part = React.useSyncExternalStore(owner.subscribe, () => owner.getState().part[message.id][0]);
    if (part.type !== 'tool') throw new Error('Expected tool result');
    const completion = useToolContentCompletion(part, true);
    return <span>{completion.status}</span>;
  }
  try {
    await act(async () => { root.render(<Result />); });
    expect(fetchMessage.mock.calls).toEqual([[session.id, message.id, 'D:/git-gc-opt']]);
    expect(container.textContent).toBe('whole');
    expect(owner.getState().part[message.id]).toEqual([whole]);
    expect(other.getState().message[session.id]).toBeUndefined();
    expect(other.getState().part[message.id]).toBeUndefined();
  } finally {
    await act(async () => { root.unmount(); });
    fetchMessage.mockRestore();
    manager.disposeAll();
    await happyWindow.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
