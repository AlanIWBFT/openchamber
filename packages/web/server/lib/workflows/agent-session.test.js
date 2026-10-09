import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkflowAgentStopped, createWorkflowAgentSessions } from './agent-session.js';

afterEach(() => vi.restoreAllMocks());

const createSessions = (client) => createWorkflowAgentSessions({
  buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
  getOpenCodeAuthHeaders: () => ({}),
  globalEventHub: { subscribeEvent: () => () => {} },
  createClient: () => client,
});

/** Creates an agent's session and stops before its prompt, to read the request. */
const createSessionRequest = async ({ parent, allowTools, model }) => {
  const created = [];
  const sessions = createWorkflowAgentSessions({
    buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
    getOpenCodeAuthHeaders: () => ({}),
    globalEventHub: { subscribeEvent: () => () => {} },
    createClient: () => ({
      session: {
        get: async () => parent,
        create: async (request) => {
          created.push(request);
          return { id: 'ses_agent' };
        },
      },
    }),
  });
  const controller = new AbortController();
  await expect(sessions.start({
    directory: '/repo',
    parentSessionId: 'ses_parent',
    title: 'agent',
    model,
    allowTools,
    text: 'work',
    signal: controller.signal,
    onSession: () => controller.abort(),
  })).rejects.toBeInstanceOf(WorkflowAgentStopped);
  return created[0];
};

describe('workflow agent sessions', () => {
  it.each([0, 2])('stops model execution and persistent commands, reporting %i cleanup failures', async (failed) => {
    const stop = vi.fn(async () => ({ matched: 2, terminated: 2 - failed, failed }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = createSessions({ session: { stop } });
    await sessions.interrupt('/repo', 'ses_agent');
    expect(stop).toHaveBeenCalledWith({ sessionID: 'ses_agent' });
    expect(warning).toHaveBeenCalledTimes(failed > 0 ? 1 : 0);
    if (failed > 0) expect(warning).toHaveBeenCalledWith(expect.stringContaining('ses_agent'), '2 persistent commands could not be stopped');
    sessions.stop();
  });

  it('stops a prompt that landed after cancellation and reports command cleanup failure', async () => {
    const controller = new AbortController();
    const stop = vi.fn(async () => ({ matched: 1, terminated: 0, failed: 1 }));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sessions = createSessions({
      message: { list: async () => ({ data: [] }) },
      session: { prompt: async () => controller.abort(), stop },
    });
    await expect(sessions.followUp({ directory: '/repo', sessionId: 'ses_agent', text: 'work', signal: controller.signal }))
      .rejects.toBeInstanceOf(WorkflowAgentStopped);
    expect(stop).toHaveBeenCalledWith({ sessionID: 'ses_agent' });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('ses_agent'), '1 persistent commands could not be stopped');
    sessions.stop();
  });

  it.each([undefined, 0, 123])('reads backend archive state, including timestamp %s', async (archived) => {
    const sessions = createSessions({ session: { get: async () => ({ time: { archived } }) } });
    await expect(sessions.isArchived('ses_parent')).resolves.toBe(archived !== undefined);
    sessions.stop();
  });

  it('does not turn failed or malformed archive reads into an unarchived answer', async () => {
    const sessions = createSessions({ session: { get: vi.fn().mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 })).mockResolvedValueOnce({}) } });
    await expect(sessions.isArchived('ses_parent')).rejects.toMatchObject({ status: 404 });
    await expect(sessions.isArchived('ses_parent')).rejects.toThrow();
    sessions.stop();
  });

  it('recognizes deletion through the real SDK error envelope without directory scoping', async () => {
    const sessions = createWorkflowAgentSessions({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'test' }),
      globalEventHub: { subscribeEvent: () => () => {} },
      fetchImpl: async (url, init) => {
        expect(String(url)).toBe('http://127.0.0.1:4096/api/session/ses_parent');
        expect(new Headers(init.headers).get('x-opencode-directory')).toBeNull();
        expect(new Headers(init.headers).get('Authorization')).toBe('test');
        return Response.json({ _tag: 'SessionNotFoundError', sessionID: 'ses_parent' }, { status: 404 });
      },
    });
    await expect(sessions.isArchived('ses_parent')).rejects.toMatchObject({ status: 404 });
    sessions.stop();
  });

  it("allows the asked tools after the parent's own rules", async () => {
    const parentRule = { action: 'bash', resource: '*', effect: 'deny' };
    const request = await createSessionRequest({
      parent: { id: 'ses_parent', permissions: [parentRule] },
      allowTools: ['openchamber_workflow_answer'],
      model: 'openai/gpt-6-luna',
    });
    expect(request.permissions).toEqual([parentRule, { action: 'openchamber_workflow_answer', resource: '*', effect: 'allow' }]);
  });

  it('sets no permissions without tools to allow, so the parent rules are inherited', async () => {
    const request = await createSessionRequest({ parent: { id: 'ses_parent' }, allowTools: [], model: 'openai/gpt-6-luna' });
    expect(request).not.toHaveProperty('permissions');
  });

  it("leaves permissions alone when the parent's rules cannot be read", async () => {
    const request = await createSessionRequest({ parent: null, allowTools: ['openchamber_workflow_answer'], model: 'openai/gpt-6-luna' });
    expect(request).not.toHaveProperty('permissions');
  });
});
