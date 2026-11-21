import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { validateSelectedCli } from './selected-cli.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode selection and version routes', () => {
  it('rejects the wrong CLI before writing settings and leaves clearing a path available', async () => {
    const persistSettings = vi.fn(async update => update);
    const validate = vi.fn(file => validateSelectedCli(file, binary => ({ binary, args: [] })));
    const { app } = createApp({ persistSettings, validateSelectedCli: validate, readSettingsFromDiskMigrated: async () => ({ opencodeBinary: '/working/fork' }) });
    await request(app).put('/api/config/settings').send({ opencodeBinary: process.execPath }).expect(400);
    expect(persistSettings).not.toHaveBeenCalled();
    await request(app).put('/api/config/settings').send({ opencodeBinary: '' }).expect(200);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(persistSettings).toHaveBeenCalledTimes(1);
  });
  it('bounds the version read when the running backend never responds', async () => {
    globalThis.fetch = vi.fn((_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    });
    const { app } = createApp();

    const response = await request(app).get('/api/opencode/version').timeout({ deadline: 5_000 }).expect(500);

    expect(response.body).toEqual({ version: null, error: expect.any(String) });
    expect(response.body.error).not.toBe('');
  });

});
