import { expect, mock, test } from 'bun:test';

const items = [
  { info: { id: 'z', seq: 1, role: 'assistant', time: { created: 900 } }, parts: [{ type: 'text', text: 'old reply' }] },
  { info: { id: 'later-prompt', seq: 4, role: 'user', time: { created: 200 } }, parts: [{ type: 'text', text: 'later prompt' }] },
  { info: { id: 'a', seq: 5, role: 'assistant', time: { created: 100 } }, parts: [{ type: 'text', text: 'latest' }, { type: 'text', text: 'reply' }] },
  { info: { id: 'first-prompt', seq: 2, role: 'user', time: { created: 800 } }, parts: [{ type: 'text', text: 'first prompt' }] },
  { info: { id: 'tool-only', seq: 6, role: 'assistant', time: { created: 50 } }, parts: [] },
];

mock.module('@/lib/opencode/client', () => ({ opencodeClient: { getSessionMessages: async () => ({ items }) } }));
mock.module('@/lib/gitApi', () => ({ getGitStatus: async () => ({ files: [] }) }));
const { loadLaneFirstPrompt, loadLaneLastTurn } = await import('./laneData');

test('lane readers use sequence order while retaining upstream empty-step skipping and part order', async () => {
  expect(await loadLaneFirstPrompt('lane', '/repo')).toEqual({ messageId: 'first-prompt', text: 'first prompt', files: [] });
  expect(await loadLaneLastTurn('lane', '/repo')).toEqual({ text: 'latest\n\nreply', error: null });
});
