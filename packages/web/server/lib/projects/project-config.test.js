import { describe, expect, it, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises';
import { createProjectConfigRuntime } from './project-config.js';

const createRuntime = async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oc-scheduled-project-config-'));
  const runtime = createProjectConfigRuntime({
    fsPromises: await import('fs/promises'),
    path,
    projectsDirPath: tempRoot,
    createTaskID: () => 'task-fixed-id',
  });
  return {
    runtime,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
};

describe('project-config runtime', () => {
  it('creates and persists a scheduled task', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'Nightly digest',
        enabled: true,
        schedule: {
          kind: 'daily',
          time: '09:30',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Summarize repository changes',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      });

      expect(result.created).toBe(true);
      expect(result.task.id).toBe('task-fixed-id');
      const reloaded = await runtime.listScheduledTasks('project-test');
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0].name).toBe('Nightly digest');
      expect(reloaded[0].schedule.timezone).toBe('UTC');
      expect(reloaded[0].schedule.times).toEqual(['09:30']);
    } finally {
      await cleanup();
    }
  });

  it('rejects invalid cron expressions', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await expect(runtime.upsertScheduledTask('project-test', {
        name: 'Invalid cron task',
        enabled: true,
        schedule: {
          kind: 'cron',
          cron: 'invalid cron',
          timezone: 'UTC',
        },
        execution: {
          prompt: 'Run checks',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      })).rejects.toThrow('schedule.cron is invalid');
    } finally {
      await cleanup();
    }
  });

  it('preserves unknown project config keys when writing scheduled tasks', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const projectID = 'path_preserve';
      const filePath = path.join(runtime.resolveProjectConfigPath(projectID));
      await writeFile(
        filePath,
        JSON.stringify({
          projectNotes: 'hello notes',
          projectTodos: [{ id: 't1', text: 'buy milk', completed: false, createdAt: 1 }],
          projectActions: [{ id: 'a1', name: 'Run', command: 'bun run dev' }],
          projectActionsPrimaryId: 'a1',
          'setup-worktree': ['bun install'],
          projectPlanFiles: [{ id: 'p1', path: '/tmp/plans/p1.md', createdAt: 2 }],
          projectPath: '/tmp/demo',
        }, null, 2),
        'utf8',
      );

      await runtime.upsertScheduledTask(projectID, {
        name: 'nightly',
        enabled: true,
        schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' },
        execution: { prompt: 'run', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      const raw = JSON.parse(await readFile(filePath, 'utf8'));
      expect(raw.projectNotes).toBe('hello notes');
      expect(raw.projectTodos).toEqual([{ id: 't1', text: 'buy milk', completed: false, createdAt: 1 }]);
      expect(raw.projectActions).toHaveLength(1);
      expect(raw.projectActionsPrimaryId).toBe('a1');
      expect(raw['setup-worktree']).toEqual(['bun install']);
      expect(raw.projectPlanFiles).toEqual([{ id: 'p1', path: '/tmp/plans/p1.md', createdAt: 2 }]);
      expect(raw.projectPath).toBe('/tmp/demo');
      expect(raw.scheduledTasks).toHaveLength(1);
      expect(raw.version).toBe(1);
    } finally {
      await cleanup();
    }
  });

  it('preserves scheduled task state timestamps when listing tasks', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const projectID = 'timestamp_preserve';
      const filePath = path.join(runtime.resolveProjectConfigPath(projectID));
      await writeFile(
        filePath,
        JSON.stringify({
          scheduledTasks: [{
            id: 'task-existing',
            name: 'nightly',
            enabled: true,
            schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
            execution: { prompt: 'run', providerID: 'openai', modelID: 'gpt-4.1' },
            state: { createdAt: 10, updatedAt: 20, lastStatus: 'idle' },
          }],
        }, null, 2),
        'utf8',
      );

      const first = await runtime.listScheduledTasks(projectID);
      const second = await runtime.listScheduledTasks(projectID);

      expect(first[0].state.createdAt).toBe(10);
      expect(first[0].state.updatedAt).toBe(20);
      expect(second[0].state.updatedAt).toBe(20);
    } finally {
      await cleanup();
    }
  });

  it('accepts one-time schedule with date and time', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const result = await runtime.upsertScheduledTask('project-test', {
        name: 'One-time review',
        enabled: true,
        schedule: {
          kind: 'once',
          date: '2026-04-20',
          time: '13:45',
          timezone: 'Europe/Kyiv',
        },
        execution: {
          prompt: 'Create a release summary',
          providerID: 'openai',
          modelID: 'gpt-4.1',
        },
      });

      expect(result.task.schedule.kind).toBe('once');
      expect(result.task.schedule.date).toBe('2026-04-20');
      expect(result.task.schedule.time).toBe('13:45');
      expect(result.task.schedule.timezone).toBe('Europe/Kyiv');
    } finally {
      await cleanup();
    }
  });
});

describe('project-config loop reconciliation', () => {
  const loop = (name, overrides = {}) => ({
    scope: 'project',
    filePath: `/repo/.agents/loops/${name}.md`,
    definition: {
      name,
      enabled: true,
      schedule: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      execution: {
        prompt: `Loop prompt for ${name}`,
        providerID: 'openai',
        modelID: 'gpt-4.1',
      },
      ...overrides,
    },
  });

  it('creates tasks for discovered loops with deterministic ids', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const tasks = await runtime.reconcileLoopTasks('project-test', [
        loop('daily-digest'),
        loop('weekly-report'),
      ]);

      expect(tasks).toHaveLength(2);
      const digest = tasks.find((task) => task.name === 'daily-digest');
      expect(digest.id).toBe('loop:project:daily-digest');
      expect(digest.schedule.cron).toBe('0 9 * * *');
      expect(digest.execution.providerID).toBe('openai');
      expect(digest.loopFile).toBe('/repo/.agents/loops/daily-digest.md');

      const reloaded = await runtime.listScheduledTasks('project-test');
      expect(reloaded).toHaveLength(2);
      expect(reloaded[0].state.createdAt).toBeGreaterThan(0);
    } finally {
      await cleanup();
    }
  });

  it('adopts an existing task by name, preserving id and state, and persists state across reconciles', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const created = await runtime.upsertScheduledTask('project-test', {
        name: 'daily-digest',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'JSON prompt', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      const first = await runtime.reconcileLoopTasks('project-test', [loop('daily-digest')]);
      const adopted = first.find((task) => task.id === created.task.id);
      expect(adopted).toBeDefined();
      expect(adopted.id).toBe(created.task.id);
      expect(adopted.name).toBe('daily-digest');
      expect(adopted.schedule.kind).toBe('cron');
      expect(adopted.schedule.cron).toBe('0 9 * * *');
      expect(adopted.execution.prompt).toBe('Loop prompt for daily-digest');
      expect(adopted.loopFile).toBe('/repo/.agents/loops/daily-digest.md');

      const state = adopted.state;
      await runtime.updateScheduledTaskState('project-test', adopted.id, {
        nextRunAt: 123456,
        lastRunAt: 111,
        lastStatus: 'success',
      });

      const second = await runtime.reconcileLoopTasks('project-test', [loop('daily-digest')]);
      const again = second.find((task) => task.id === created.task.id);
      expect(again.id).toBe(created.task.id);
      expect(again.state.nextRunAt).toBe(123456);
      expect(again.state.lastRunAt).toBe(111);
      expect(again.state.lastStatus).toBe('success');
      expect(again.loopFile).toBe('/repo/.agents/loops/daily-digest.md');
    } finally {
      await cleanup();
    }
  });

  it('unschedules a loop-sourced task when its file is removed', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      await runtime.reconcileLoopTasks('project-test', [loop('daily-digest')]);
      const tasks = await runtime.reconcileLoopTasks('project-test', []);

      expect(tasks).toHaveLength(0);
      expect(await runtime.listScheduledTasks('project-test')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  it('leaves JSON-configured tasks untouched when no loop matches', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const created = await runtime.upsertScheduledTask('project-test', {
        name: 'json-only',
        enabled: true,
        schedule: { kind: 'daily', time: '08:00', timezone: 'UTC' },
        execution: { prompt: 'JSON prompt', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      const tasks = await runtime.reconcileLoopTasks('project-test', [loop('loop-only')]);

      expect(tasks).toHaveLength(2);
      expect(tasks.find((task) => task.id === created.task.id)).toBeDefined();
      expect(tasks.find((task) => task.name === 'loop-only')).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it('does not remove a JSON task that merely shares a loop name after the loop is gone... keeps it when never adopted', async () => {
    // A JSON task that was never driven by a loop file (no loopFile marker)
    // must survive reconciles even when a loop with the same name existed
    // only in a previous reconcile round — but once a loop adopted it, the
    // file is authoritative and removing the file unschedules the task.
    const { runtime, cleanup } = await createRuntime();
    try {
      const created = await runtime.upsertScheduledTask('project-test', {
        name: 'daily-digest',
        enabled: true,
        schedule: { kind: 'daily', time: '09:30', timezone: 'UTC' },
        execution: { prompt: 'JSON prompt', providerID: 'openai', modelID: 'gpt-4.1' },
      });

      // First reconcile adopts the task (loopFile marker set).
      await runtime.reconcileLoopTasks('project-test', [loop('daily-digest')]);
      // Loop file removed -> task unscheduled.
      const afterRemoval = await runtime.reconcileLoopTasks('project-test', []);
      expect(afterRemoval.find((task) => task.id === created.task.id)).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('skips invalid loop definitions without blocking valid ones', async () => {
    const { runtime, cleanup } = await createRuntime();
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const tasks = await runtime.reconcileLoopTasks('project-test', [
          loop('bad-loop', { schedule: { kind: 'cron', cron: 'not a cron', timezone: 'UTC' } }),
          loop('good-loop'),
        ]);

        expect(tasks.map((task) => task.name)).toEqual(['good-loop']);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    } finally {
      await cleanup();
    }
  });
});
