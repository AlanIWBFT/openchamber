import { describe, expect, it, vi } from 'vitest';

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { createOpenChamberControlService } from './service.js';

const createService = (overrides = {}) => {
  const client = {
    session: {
      list: vi.fn(async () => ({ data: [] })),
      status: vi.fn(async () => ({ data: {} })),
      messages: vi.fn(async () => ({ data: [] })),
    },
  };
  const sessionService = {
    create: vi.fn(async () => ({ sessionId: 'ses_1', directory: '/repo', promptDispatched: false })),
    send: vi.fn(),
    fork: vi.fn(),
  };
  const scheduledTaskService = {
    status: vi.fn(async () => ({ enabledScheduledTasksCount: 0 })),
    resolveProjectID: vi.fn(async () => 'project-1'),
    list: vi.fn(async () => []),
    upsert: vi.fn(),
    run: vi.fn(),
    remove: vi.fn(),
    setEnabled: vi.fn(),
  };
  const service = createOpenChamberControlService({
    readSettingsFromDiskMigrated: vi.fn(async () => ({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
      defaultModel: 'provider/model',
      favoriteModels: [],
      recentModels: [],
    })),
    sanitizeProjects: (projects) => projects,
    buildOpenCodeUrl: () => 'http://127.0.0.1:4096/',
    getOpenCodeAuthHeaders: () => ({ authorization: 'Basic test' }),
    waitForOpenCodeReady: vi.fn(),
    createClient: vi.fn(() => client),
    sessionService,
    scheduledTaskService,
    ...overrides,
  });
  return { service, client, sessionService, scheduledTaskService };
};

describe('OpenChamber control service', () => {
  it('serves project and model projections without an HTTP or CLI round trip', async () => {
    const { service } = createService();
    await expect(service.execute('projects.list')).resolves.toEqual({
      projects: [{ id: 'project-1', path: '/repo', label: 'Repo' }],
    });
    await expect(service.execute('models.list')).resolves.toEqual(expect.objectContaining({
      defaultModel: 'provider/model',
      favoriteModels: [],
    }));
  });

  it('maps schedule creation into the shared scheduled-task service', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.upsert.mockResolvedValue({ task: { id: 'task-1' }, created: true });
    await expect(service.execute('schedule.create', {
      directory: '/repo',
      name: 'Daily',
      prompt: 'Run checks',
      model: 'provider/model',
      daily: ' 09:00 ',
      goal: true,
      goalTokenBudget: 5000,
    })).resolves.toEqual({ task: { id: 'task-1' }, created: true });
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: undefined, directory: '/repo' });
    expect(scheduledTaskService.upsert).toHaveBeenCalledWith('project-1', expect.objectContaining({
      name: 'Daily',
      schedule: { kind: 'daily', times: ['09:00'] },
      execution: expect.objectContaining({ providerID: 'provider', modelID: 'model', goalEnabled: true, goalTokenBudget: 5000 }),
    }));
  });

  it('does not combine an explicit schedule project with the tool context directory', async () => {
    const { service, scheduledTaskService } = createService();
    await service.execute('schedule.list', { projectId: ' project-1 ' }, '/current-session');
    expect(scheduledTaskService.resolveProjectID).toHaveBeenCalledWith({ projectId: 'project-1', directory: undefined });
  });

  it('includes scheduler status alongside listed tasks', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.list.mockResolvedValue([{ id: 'task-1' }]);
    await expect(service.execute('schedule.list', {}, '/repo')).resolves.toEqual({
      scheduler: { enabledScheduledTasksCount: 0 },
      tasks: [{ id: 'task-1' }],
    });
  });

  it('toggles a scheduled task through the required disabled boolean', async () => {
    const { service, scheduledTaskService } = createService();
    scheduledTaskService.setEnabled.mockResolvedValue({ id: 'task-1', enabled: false });
    await expect(service.execute('schedule.toggle', { taskId: 'task-1' }, '/repo')).rejects.toThrow('disabled is required for schedule.toggle');
    await expect(service.execute('schedule.toggle', { taskId: 'task-1', disabled: true }, '/repo')).resolves.toEqual({
      task: { id: 'task-1', enabled: false },
      enabled: false,
    });
    expect(scheduledTaskService.setEnabled).toHaveBeenCalledWith('project-1', 'task-1', false);
  });

  it('returns an actionable taskId error before resolving schedule scope', async () => {
    const { service, scheduledTaskService } = createService();
    await expect(service.execute('schedule.run', {}, '/repo')).rejects.toThrow('taskId is required');
    expect(scheduledTaskService.resolveProjectID).not.toHaveBeenCalled();
    expect(scheduledTaskService.run).not.toHaveBeenCalled();
  });

  it('validates wait modifiers before creating a session', async () => {
    const { service, sessionService } = createService();
    await expect(service.execute('session.create', { directory: '/repo', timeout: 30 })).rejects.toThrow('timeout requires wait');
    expect(sessionService.create).not.toHaveBeenCalled();
  });

  it('uses the tool context directory for session actions', async () => {
    const { service, sessionService } = createService();
    await service.execute('session.create', { title: 'From tool' }, '/repo');
    expect(sessionService.create).toHaveBeenCalledWith({ directory: '/repo', title: 'From tool' });
  });

  it.each([
    ['session.send', 'send'],
    ['session.fork', 'fork'],
  ])('delegates %s directly to the session service', async (action, method) => {
    const { service, sessionService } = createService();
    sessionService[method].mockResolvedValue({ sessionId: 'ses_1', directory: '/repo' });

    await service.execute(action, { sessionId: 'ses_1', directory: '/repo', prompt: 'Continue' });

    expect(sessionService[method]).toHaveBeenCalledWith('ses_1', { directory: '/repo', prompt: 'Continue' });
  });

  it('resolves the target session directory from the global session list when send omits it', async () => {
    const { service, sessionService, client } = createService({
      createClient: () => ({
        ...client,
        experimental: {
          session: {
            list: vi.fn(async () => ({
              data: [
                { id: 'ses_other', directory: '/repo/worktrees/other' },
                { id: 'ses_target', directory: '/repo/worktrees/target' },
              ],
            })),
          },
        },
      }),
    });
    sessionService.send.mockResolvedValue({ sessionId: 'ses_target', directory: '/repo/worktrees/target', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_target', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_target', { directory: '/repo/worktrees/target', prompt: 'Continue' });
  });

  it('falls back to the context directory when the session is not in the global list', async () => {
    const { service, sessionService, client } = createService({
      createClient: () => ({
        ...client,
        experimental: { session: { list: vi.fn(async () => ({ data: [] })) } },
      }),
    });
    sessionService.send.mockResolvedValue({ sessionId: 'ses_unknown', directory: '/repo', promptDispatched: true });

    await service.execute('session.send', { sessionId: 'ses_unknown', prompt: 'Continue' }, '/repo');

    expect(sessionService.send).toHaveBeenCalledWith('ses_unknown', { directory: '/repo', prompt: 'Continue' });
  });

  it('waits past initial idle until a completed assistant result appears', async () => {
    let timestamp = 1000;
    const { service, client, sessionService } = createService({
      now: () => timestamp,
      sleep: async (duration) => { timestamp += duration; },
    });
    sessionService.create.mockResolvedValue({
      sessionId: 'ses_1',
      directory: '/repo',
      promptDispatched: true,
      baselineAssistantMessageId: 'msg_old',
    });
    client.session.status.mockResolvedValue({ data: { ses_1: { type: 'idle' } } });
    client.session.messages
      .mockResolvedValueOnce({ data: [{ info: { id: 'msg_old', role: 'assistant', time: { completed: 900 } }, parts: [{ type: 'text', text: 'old' }] }] })
      .mockResolvedValueOnce({ data: [{ info: { id: 'msg_new', role: 'assistant', time: { completed: 1500 } }, parts: [{ type: 'text', text: 'done' }] }] })
      .mockResolvedValueOnce({ data: [{ info: { id: 'msg_new', role: 'assistant', time: { completed: 1500 } }, parts: [{ type: 'text', text: 'done' }] }] });

    await expect(service.execute('session.create', {
      directory: '/repo',
      prompt: 'work',
      wait: true,
      lastAssistant: true,
      timeout: 2,
    })).resolves.toEqual(expect.objectContaining({
      sessionStatus: { type: 'idle' },
      lastAssistantMessage: expect.objectContaining({ id: 'msg_new', text: 'done' }),
    }));
    expect(client.session.status).toHaveBeenCalledTimes(2);
  });

  it('filters archived sessions and adds directory-scoped statuses', async () => {
    const { service, client } = createService();
    client.session.list.mockResolvedValue({ data: [
      { id: 'ses_active', directory: '/repo', time: {} },
      { id: 'ses_archived', directory: '/repo', time: { archived: 100 } },
      { id: 'ses_other', directory: '/other', time: {} },
    ] });
    client.session.status
      .mockResolvedValueOnce({ data: { ses_active: { type: 'busy' } } })
      .mockRejectedValueOnce(new Error('unavailable'));

    await expect(service.execute('session.list', { limit: 10, withStatus: true })).resolves.toEqual({
      sessions: [
        { id: 'ses_active', directory: '/repo', time: {}, status: { type: 'busy' } },
        { id: 'ses_other', directory: '/other', time: {}, status: { type: 'unknown' } },
      ],
      limit: 10,
      directory: null,
      archived: 'excluded',
    });
  });

  it('names limit in positive-integer validation errors', async () => {
    const { service, client } = createService();
    await expect(service.execute('session.list', { limit: 0 })).rejects.toThrow('limit must be a positive integer');
    expect(client.session.list).not.toHaveBeenCalled();
  });

  it('projects only ordered text parts from session messages', async () => {
    const { service, client } = createService();
    client.session.messages.mockResolvedValue({ data: [
      {
        info: { id: 'msg_assistant', role: 'assistant', providerID: 'openai', modelID: 'gpt-5.4-mini', time: { created: 20, completed: 30 } },
        parts: [{ type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'First ' }, { type: 'tool' }, { type: 'text', text: 'answer' }],
      },
      { info: { id: 'msg_user', role: 'user', time: { created: 10 } }, parts: [{ type: 'text', text: 'Question' }] },
      { info: { id: 'msg_tool', role: 'assistant', time: { created: 15 } }, parts: [{ type: 'tool' }] },
    ] });

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      all: true,
    })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      sessionStatus: { type: 'idle' },
      messages: [
        { id: 'msg_user', role: 'user', createdAt: 10, completedAt: null, model: null, text: 'Question' },
        { id: 'msg_assistant', role: 'assistant', createdAt: 20, completedAt: 30, model: 'openai/gpt-5.4-mini', text: 'First answer' },
      ],
    });
  });

  it('projects completed question selections with unique non-forkable IDs', async () => {
    const { service, client, sessionService } = createService();
    client.session.messages.mockResolvedValue({ data: [
      {
        info: { id: 'msg_question', role: 'assistant', time: { created: 20, completed: 40 } },
        parts: [
          { type: 'text', text: 'Please choose.' },
          {
            id: 'prt_question',
            type: 'tool',
            tool: 'question',
            callID: 'call_question',
            state: {
              status: 'completed',
              input: {
                questions: [
                  { question: 'Which environments?' },
                  { question: 'Anything else?' },
                  { question: 'Optional?' },
                ],
              },
              output: 'Generated tool prose is not used',
              title: 'Asked 3 questions',
              metadata: { answers: [['Staging', 'Production'], ['Deploy canary first\nthen promote'], []] },
              time: { start: 21, end: 30 },
            },
          },
          {
            id: 'prt_other',
            type: 'tool',
            tool: 'bash',
            state: {
              status: 'completed',
              input: {},
              output: 'Not a user answer',
              title: 'Command',
              metadata: { answers: [['ignored']] },
              time: { start: 31, end: 32 },
            },
          },
          {
            id: 'prt_pending',
            type: 'tool',
            tool: 'question',
            state: {
              status: 'running',
              input: { questions: [{ question: 'Still waiting?' }] },
              metadata: { answers: [['ignored']] },
              time: { start: 33 },
            },
          },
        ],
      },
      {
        info: { id: 'msg_final_question', role: 'assistant', time: { created: 50, completed: 70 } },
        parts: [{
          id: 'prt_final_question',
          type: 'tool',
          tool: 'question',
          callID: 'call_final_question',
          state: {
            status: 'completed',
            input: { questions: [{ question: 'Ready to finish?' }] },
            output: 'Generated tool prose is not used',
            title: 'Asked 1 question',
            metadata: { answers: [['Yes']] },
            time: { start: 51, end: 60 },
          },
        }],
      },
    ] });

    const expectedMessage = {
      id: 'question-answer:msg_question:prt_question',
      role: 'user',
      createdAt: 30,
      completedAt: null,
      model: null,
      text: 'Question: Which environments?\nAnswer: Staging\nAnswer: Production\n\nQuestion: Anything else?\nAnswer: Deploy canary first\nthen promote',
    };
    const expectedAssistantMessage = {
      id: 'msg_question',
      role: 'assistant',
      createdAt: 20,
      completedAt: 40,
      model: null,
      text: 'Please choose.',
    };
    const expectedFinalMessage = {
      id: 'question-answer:msg_final_question:prt_final_question',
      role: 'user',
      createdAt: 60,
      completedAt: null,
      model: null,
      text: 'Question: Ready to finish?\nAnswer: Yes',
    };

    await expect(service.execute('session.messages', {
      sessionId: 'ses_1',
      directory: '/repo',
      all: true,
    })).resolves.toEqual({
      sessionId: 'ses_1',
      directory: '/repo',
      role: 'all',
      sessionStatus: { type: 'idle' },
      messages: [expectedAssistantMessage, expectedMessage, expectedFinalMessage],
    });
    await expect(service.execute('session.messages', {
      sessionId: 'ses_1', directory: '/repo', role: 'user', all: true,
    })).resolves.toEqual(expect.objectContaining({ role: 'user', messages: [expectedMessage, expectedFinalMessage] }));
    await expect(service.execute('session.messages', {
      sessionId: 'ses_1', directory: '/repo', role: 'assistant', all: true,
    })).resolves.toEqual(expect.objectContaining({ role: 'assistant', messages: [expectedAssistantMessage] }));

    await expect(service.execute('session.fork', {
      sessionId: 'ses_1', directory: '/repo', messageId: expectedMessage.id, prompt: 'Continue',
    })).rejects.toThrow('question-answer IDs are synthetic and cannot be used as session.fork messageId');
    expect(sessionService.fork).not.toHaveBeenCalled();
  });

  it('rejects actions outside the fixed contract', async () => {
    const { service } = createService();
    await expect(service.execute('session.delete')).rejects.toThrow('Unsupported OpenChamber action');
  });
});

describe('browser capture', () => {
  const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const createBrowserService = async (capture) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-capture-'));
    const request = vi.fn(async () => capture);
    const { service } = createService({ browserControl: { request } });
    return { service, directory, request };
  };

  it('saves the image beside the code and hands back a path the answer can use', async () => {
    const { service, directory } = await createBrowserService({
      base64: pixel,
      mime: 'image/png',
      url: 'http://localhost:3000/',
      title: 'App',
      viewport: { mode: 'mobile', width: 390, height: 844 },
      width: 390,
      height: 844,
    });

    const result = await service.execute('browser.capture', { label: 'After fix' }, directory);

    expect(result.path.startsWith('.openchamber/screenshots/after-fix-')).toBe(true);
    expect(result.path.endsWith('.png')).toBe(true);
    expect(result.url).toBe('http://localhost:3000/');
    expect(result.viewport).toEqual({ mode: 'mobile', width: 390, height: 844 });
    // The bytes stay on disk; a tool result is not a place to carry an image.
    expect('base64' in result).toBe(false);
    const written = await fs.readFile(path.join(directory, result.path));
    expect(written.length > 0).toBe(true);
  });

  it('tells the agent how to actually show the image', async () => {
    const { service, directory } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    const result = await service.execute('browser.capture', {}, directory);
    expect(result.hint).toContain(`![](${result.path})`);
  });

  it('refuses to capture with no project to save into', async () => {
    const { service } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await expect(service.execute('browser.capture', {})).rejects.toThrow(/directory is required/);
  });

  it('passes a label through to the browser and leaves other actions untouched', async () => {
    const { service, directory, request } = await createBrowserService({ base64: pixel, mime: 'image/png' });
    await service.execute('browser.capture', { label: 'before' }, directory);
    expect(request).toHaveBeenCalledWith('browser.capture', { label: 'before' }, expect.anything());
  });
});
