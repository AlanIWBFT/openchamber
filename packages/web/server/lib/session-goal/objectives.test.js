import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import express from 'express';
import request from 'supertest';
import { copyObjectiveIfAbsent, deleteObjective, GOAL_OBJECTIVE_CHAR_LIMIT, readObjective, writeObjective } from './objectives.js';
import { registerSessionGoalRoutes } from './routes.js';

let dataDir;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-goals-'));
  vi.stubEnv('OPENCHAMBER_DATA_DIR', dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('goal objective files', () => {
  it('trims, clamps and stores the objective under the session id', async () => {
    const content = 'x'.repeat(GOAL_OBJECTIVE_CHAR_LIMIT);
    await expect(writeObjective('ses_123', `  ${content}extra  `)).resolves.toEqual({ content });
    expect(await fs.readFile(path.join(dataDir, 'goals', 'ses_123.md'), 'utf8')).toBe(content);
    await expect(readObjective('ses_123')).resolves.toBe(content);
  });

  it.each([
    [42, '42'],
    [false, 'false'],
    [['a', 'b'], 'a,b'],
    [{ task: 'finish' }, '[object Object]'],
  ])('preserves content coercion for %j', async (input, content) => {
    await expect(writeObjective('ses_123', input)).resolves.toEqual({ content });
  });

  it.each([undefined, null, '', '   '])('rejects empty content %j', async (content) => {
    await expect(writeObjective('ses_123', content)).rejects.toMatchObject({
      statusCode: 400,
      message: 'objective content is required',
    });
  });

  it.each([undefined, null, 1234, '../escape', 'abc', 'x'.repeat(129)])('rejects invalid session id %j before filesystem access', async (sessionId) => {
    await expect(writeObjective(sessionId, 'task')).rejects.toMatchObject({
      statusCode: 400,
      message: 'invalid session id',
    });
    await expect(readObjective(sessionId)).resolves.toBeNull();
    await expect(deleteObjective(sessionId)).resolves.toBeUndefined();
    expect(await fs.readdir(dataDir)).toEqual([]);
  });

  it('returns null for a missing file and deletes existing files best-effort', async () => {
    await expect(readObjective('ses_123')).resolves.toBeNull();
    await expect(deleteObjective('ses_123')).resolves.toBeUndefined();
    await writeObjective('ses_123', 'task');
    await deleteObjective('ses_123');
    await expect(readObjective('ses_123')).resolves.toBeNull();
  });

  it('reads live edits and preserves an empty file as an empty string', async () => {
    await writeObjective('ses_123', 'task');
    const file = path.join(dataDir, 'goals', 'ses_123.md');
    await fs.writeFile(file, '  changed task  ');
    await expect(readObjective('ses_123')).resolves.toBe('changed task');
    await fs.writeFile(file, '   ');
    await expect(readObjective('ses_123')).resolves.toBe('');
  });

  it('propagates write failures and returns null for unreadable objective paths', async () => {
    await fs.writeFile(path.join(dataDir, 'goals'), 'not a directory');
    await expect(writeObjective('ses_123', 'task')).rejects.toThrow();
    await expect(readObjective('ses_123')).resolves.toBeNull();
    await expect(deleteObjective('ses_123')).resolves.toBeUndefined();
  });
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
    expect(await fs.readdir(path.join(dataDir, 'goals'))).toEqual(['ses_fork.md']);
  });

  it('preserves a new objective written after the copy started but before publication', async () => {
    const link = fs.link.bind(fs);
    vi.spyOn(fs, 'link').mockImplementationOnce(async (source, destination) => {
      await writeObjective('ses_fork', 'created while copying');
      return link(source, destination);
    });
    await copyObjectiveIfAbsent('ses_fork', 'inherited');
    expect(await readObjective('ses_fork')).toBe('created while copying');
    expect(await fs.readdir(path.join(dataDir, 'goals'))).toEqual(['ses_fork.md']);
  });
});
