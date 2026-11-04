import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { copyObjectiveIfAbsent, readObjective, writeObjective } from './objectives.js';
import { registerSessionGoalRoutes } from './routes.js';

let directory;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-goal-copy-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', directory);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('inherited goal objective publication', () => {
  it('honors the UI inheritance request without changing normal goal writes', async () => {
    const app = express();
    app.use(express.json());
    registerSessionGoalRoutes(app);
    await request(app).put('/api/goals/objective/ses_fork').send({ content: 'user goal' }).expect(200);
    await request(app).put('/api/goals/objective/ses_fork').send({ content: 'inherited', ifAbsent: true }).expect(200);
    expect(await readObjective('ses_fork')).toBe('user goal');
    await request(app).put('/api/goals/objective/ses_fork').send({ content: 'edited' }).expect(200);
    expect(await readObjective('ses_fork')).toBe('edited');
  });

  it('publishes an inherited objective but never replaces a new goal', async () => {
    await copyObjectiveIfAbsent('ses_fork', 'inherited');
    expect(await readObjective('ses_fork')).toBe('inherited');
    await writeObjective('ses_fork', 'new goal');
    await copyObjectiveIfAbsent('ses_fork', 'stale inherited');
    expect(await readObjective('ses_fork')).toBe('new goal');
    expect(await fs.readdir(path.join(directory, 'goals'))).toEqual(['ses_fork.md']);
  });

  it('preserves a new objective written after the copy started but before publication', async () => {
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementationOnce(async (source, destination) => {
      await writeObjective('ses_fork', 'created while copying');
      return link(source, destination);
    });
    await copyObjectiveIfAbsent('ses_fork', 'inherited');
    expect(await readObjective('ses_fork')).toBe('created while copying');
    expect(await fs.readdir(path.join(directory, 'goals'))).toEqual(['ses_fork.md']);
  });
});
