import { describe, expect, test } from 'bun:test';
import type { Message, Part, Session } from '@/lib/opencode/model';

import { buildSessionMessageRecordsSnapshot } from './sync-context';
import { INITIAL_STATE, type State } from './types';
import { buildTimelineRows } from '@/components/chat/lib/turns/timelineRows';
import { projectTurnRecords } from '@/components/chat/lib/turns/projectTurnRecords';
import { buildLiveStreamingEntry } from '@/components/chat/lib/turns/streamingTailEntry';
import { projectLiveActivityPreview } from '@/components/chat/lib/turns/liveActivity';

// v2 messages carry no `parentID`; the argument is kept only so the fixtures
// still read as "this reply belongs to that prompt".
const message = (id: string, role: 'user' | 'assistant', _parentID?: string, created = 1): Message =>
  role === 'user'
    ? { id, role, sessionID: 'ses_1', time: { created } }
    : { id, role, sessionID: 'ses_1', time: { created }, agent: 'build', providerID: 'provider', modelID: 'model' };

const textPart = (id: string, text: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
});

const taskPart = (id: string, sessionId?: string): Part => ({
  id,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'tool',
  callID: id,
  tool: 'task',
  state: {
    status: 'running',
    input: {},
    time: { start: 1 },
    metadata: sessionId ? { sessionId } : {},
  },
});

const session = (overrides: Partial<Session> = {}): Session => ({
  id: 'ses_1',
  projectID: 'proj_1',
  directory: '/repo',
  title: 'Session',
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  ...overrides,
});

const state = (partial: Partial<State>): State => ({
  ...INITIAL_STATE,
  ...partial,
});

describe('buildSessionMessageRecordsSnapshot', () => {
  for (const fence of ['```', '~~~']) test(`keeps prose visible when a streamed ${fence}openui-lang block becomes a page`, () => {
    const user = message('user_1', 'user');
    const assistant = message('assistant_1', 'assistant');
    if (assistant.role !== 'assistant') throw new Error('Expected assistant fixture');
    const messages = [user, assistant];
    const read: Part = { id: 'read', sessionID: 'ses_1', messageID: assistant.id, type: 'tool', callID: 'read', tool: 'read',
      state: { status: 'completed', input: {}, output: 'done', metadata: {}, time: { start: 1, end: 2 } } };
    const prose = 'Wi-Fi baseline completed.\n\n';
    const options = { showTurnChangedFiles: false, showReasoningTraces: false };
    let snapshot = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: [read, textPart('text', prose)] } }),
      'ses_1', undefined, true, assistant.id);
    for (const [suffix, page, changed] of [
      [fence + 'openui-lan', false, false],
      [fence + 'openui-lang', true, true],
      [fence + 'openui-lang literal', false, true],
      [fence + 'openui-lang\nroot = Stack([', true, true],
      [fence + 'openui-lang\nroot = Stack([Text("Result")])\n' + fence + '\nAfter table.', true, false],
    ] as const) {
      const parts = [read, textPart('text', prose + suffix)];
      const next = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: parts } }), 'ses_1', snapshot, true, assistant.id);
      expect(next === snapshot).toBe(!changed);
      const base = { kind: 'turn' as const, key: 'turn:user_1', turn: projectTurnRecords(next.list, options).turns[0], isLastTurn: true };
      const rows = buildTimelineRows([base], { collapsedActivity: true, expandedTurns: new Map(), showReasoningTraces: false }, []);
      const live = buildLiveStreamingEntry(base, { ...options, livePartsByMessageId: { assistant_1: parts } });
      const preview = projectLiveActivityPreview(live.turn, false);
      expect(rows.some(row => row.kind === 'turn-pages' && row.pageId === 'text')).toBe(page);
      expect(page ? live.turn.assistantMessages[0].parts.includes(parts[1]) : preview.pinnedText?.part.text === prose + suffix).toBe(true);
      snapshot = next;
    }
    const finished: Message = { ...assistant, time: { created: 1, completed: 3 }, finish: 'stop' };
    const parts = [read, { ...textPart('text', prose + fence + 'openui-lang\nroot = Stack([Text("Result")])\n' + fence), time: { start: 1, end: 3 } }];
    const final = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: [user, finished] }, part: { assistant_1: parts } }), 'ses_1', snapshot);
    const rows = buildTimelineRows(projectTurnRecords(final.list, options).turns.map(turn => ({ kind: 'turn' as const, key: turn.turnId, turn, isLastTurn: true })),
      { collapsedActivity: true, expandedTurns: new Map(), showReasoningTraces: false }, []);
    expect(rows.some(row => row.kind === 'turn-message' && row.final && row.messageId === assistant.id)).toBe(true);
    expect(rows.some(row => row.kind === 'turn-pages')).toBe(false);
  });

  for (const [tool, input, output] of [
    ['openchamber_render', { html: '<p>Pick</p>', awaitAnswer: true }, undefined],
    ['openchamber_secret', { label: 'Token', reason: 'Connect' }, undefined],
    ['openchamber_workflow', {}, { ok: true, action: 'workflow.run', data: { runId: 'run_1' } }],
    ['openchamber_image', {}, { ok: true, action: 'image.generate', data: { images: [{ path: '/image.png' }] } }],
  ] as const) test(`publishes ${tool} card appearance, state changes and removal`, () => {
    const assistant = message('assistant_1', 'assistant');
    const messages = [assistant];
    const snapshot = (parts: Part[], previous?: ReturnType<typeof buildSessionMessageRecordsSnapshot>) =>
      buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: parts } }), 'ses_1', previous, true, assistant.id);
    const pending: Extract<Part, { type: 'tool' }> = { id: 'card', sessionID: 'ses_1', messageID: assistant.id, type: 'tool', callID: 'card', tool,
      state: { status: 'pending', input, raw: '' } };
    const previous = snapshot([pending]);
    const card: Part = { ...pending, state: output
      ? { status: 'completed', input, output: JSON.stringify(output), time: { start: 1, end: 2 }, metadata: {} }
      : { status: 'running', input, time: { start: 1 } } };
    const shown = snapshot([card], previous);
    expect(shown.list[0].parts).toEqual([card]);
    expect(snapshot([{ ...card }], shown)).toBe(shown);
    if (!output) {
      const stopped: Part = { ...card, state: { status: 'error', input, error: 'Interrupted', time: { start: 1, end: 2 } } };
      expect(snapshot([stopped], shown).list[0].parts).toEqual([stopped]);
    }
    expect(snapshot([], shown).list[0].parts).toEqual([]);
  });

  test('publishes a waiting page into timeline rows while its message is still streaming', () => {
    const user = message('user_1', 'user');
    const assistant = message('assistant_1', 'assistant');
    const messages = [user, assistant];
    const initial = [textPart('text_1', 'Choosing a certificate')];
    const previous = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: initial } }), 'ses_1', undefined, true, assistant.id);
    const page: Part = {
      id: 'page', sessionID: 'ses_1', messageID: assistant.id, type: 'tool', callID: 'page', tool: 'openchamber_render',
      state: { status: 'running', input: { request: { ui: 'root = Stack([Button("Continue")])', awaitAnswer: true } }, time: { start: 1 } },
    };
    const next = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: [...initial, page] } }), 'ses_1', previous, true, assistant.id);
    const projection = projectTurnRecords(next.list, { showTurnChangedFiles: false, showReasoningTraces: false });
    const rows = buildTimelineRows(projection.turns.map(turn => ({ kind: 'turn' as const, key: `turn:${turn.turnId}`, turn, isLastTurn: true })),
      { collapsedActivity: true, expandedTurns: new Map(), showReasoningTraces: false }, []);
    expect(rows.some(row => row.kind === 'turn-pages' && row.pageId === page.id)).toBe(true);
    const delta = [...initial, { ...page, state: { ...page.state, metadata: { progress: 'still waiting' } } }];
    const unchanged = buildSessionMessageRecordsSnapshot(state({ message: { ses_1: messages }, part: { assistant_1: delta } }), 'ses_1', next, true, assistant.id);
    expect(unchanged).toBe(next);
  });

  test('renders and reverts a rollover-spanning sequence-ordered transcript', () => {
    const before = message('msg_ffffffffffffBefore', 'user', undefined, 300);
    const marker = message('msg_000000000000Marker', 'user', undefined, 100);
    const after = message('msg_000000000001After', 'assistant', marker.id, 200);

    const snapshot = buildSessionMessageRecordsSnapshot(
      state({
        session: [session({ revert: { messageID: marker.id } })],
        message: { ses_1: [before, marker, after] },
      }),
      'ses_1',
    );

    expect(snapshot.list.map((record) => record.info.id)).toEqual([before.id]);
  });

  test('only suspends part updates for the active streaming message', () => {
    const user = message('user_1', 'user');
    const assistant1 = message('assistant_1', 'assistant', 'user_1');
    const assistant2 = message('assistant_2', 'assistant', 'user_1');
    const messages = [user, assistant1, assistant2];
    const assistant1InitialParts = [textPart('assistant_1_initial', 'initial')];
    const assistant2InitialParts = [textPart('assistant_2_initial', 'initial')];

    const previous = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1InitialParts,
          assistant_2: assistant2InitialParts,
        },
      }),
      'ses_1',
      undefined,
      true,
      'assistant_1',
    );

    const assistant1FinalParts = [textPart('assistant_1_final', 'final')];
    const assistant2LiveParts = [textPart('assistant_2_live', 'live')];
    const next = buildSessionMessageRecordsSnapshot(
      state({
        message: { ses_1: messages },
        part: {
          assistant_1: assistant1FinalParts,
          assistant_2: assistant2LiveParts,
        },
      }),
      'ses_1',
      previous,
      true,
      'assistant_2',
    );

    expect(next.byId.get('assistant_1')?.parts).toBe(assistant1FinalParts);
    expect(next.byId.get('assistant_2')?.parts).toBe(assistant2InitialParts);
  });

  test('publishes task session identity while other streaming part updates are suspended', () => {
    const assistant = message('assistant_1', 'assistant');
    const initialParts = [taskPart('task_1')];
    const previous = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: initialParts } }),
      'ses_1',
      undefined,
      true,
      assistant.id,
    );
    const identifiedParts = [taskPart('task_1', 'child_1')];

    const next = buildSessionMessageRecordsSnapshot(
      state({ message: { ses_1: [assistant] }, part: { assistant_1: identifiedParts } }),
      'ses_1',
      previous,
      true,
      assistant.id,
    );

    expect(next.byId.get(assistant.id)?.parts).toBe(identifiedParts);
  });
});
