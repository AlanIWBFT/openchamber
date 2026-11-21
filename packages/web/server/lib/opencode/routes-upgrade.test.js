import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerOpenCodeRoutes } from './routes.js';
import { validateSelectedCli } from './selected-cli.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

const supportedCapability = { supported: true, manager: 'opencode', reason: null };

const createApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  const dependencies = {
    getOpenCodeUpgradeCapability: () => ({
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    }),
    buildOpenCodeUrl: (pathname) => `http://127.0.0.1:4096${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    upgradeOpenCodeCli: vi.fn(async () => {}),
    refreshOpenCodeAfterConfigChange: vi.fn(async () => {}),
    ...overrides,
  };
  registerOpenCodeRoutes(app, dependencies);
  return { app, dependencies };
};

describe('OpenCode upgrade routes', () => {
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
  it.each([
    ['/api/opencode/upgrade-status', 'available'],
    ['/api/opencode/version', 'version'],
  ])('answers %s when OpenCode accepts the request but never responds', async (route, field) => {
    globalThis.fetch = vi.fn((url, init) => {
      if (!String(url).endsWith('/api/info')) return Promise.resolve(jsonResponse({ version: '2.0.22' }));
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    });
    const { app } = createApp();

    const response = await request(app).get(route).timeout({ deadline: 5_000 }).expect(500);

    expect(response.body).toEqual({ [field]: null, error: expect.any(String) });
    expect(response.body.error).not.toBe('');
  });

  it('only checks the local version even when a package registry is configured', async () => {
    const previousRegistry = process.env.npm_config_registry;
    const previousUserConfig = process.env.npm_config_userconfig;
    process.env.npm_config_userconfig = `${import.meta.dirname}/missing-test.npmrc`;
    process.env.npm_config_registry = 'https://user:p%40ss@mirror.example.com/npm/';
    globalThis.fetch = vi.fn(async (input) => jsonResponse({ version: String(input).endsWith('/api/info') ? '2.0.21' : '2.0.22' }));
    const { app } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
    try {
      const response = await request(app).get('/api/opencode/upgrade-status').expect(200);
      expect(response.body).toMatchObject({ available: false, currentVersion: '2.0.21', latestVersion: null });
      expect(globalThis.fetch.mock.calls.map(([url]) => String(url))).toEqual(['http://127.0.0.1:4096/api/info']);
    } finally {
      if (previousRegistry === undefined) delete process.env.npm_config_registry;
      else process.env.npm_config_registry = previousRegistry;
      if (previousUserConfig === undefined) delete process.env.npm_config_userconfig;
      else process.env.npm_config_userconfig = previousUserConfig;
    }
  });

  it('fails closed without contacting the bundled OpenCode updater', async () => {
    globalThis.fetch = vi.fn();
    const { app } = createApp();

    await request(app)
      .post('/api/opencode/upgrade')
      .send({})
      .expect(409, {
        success: false,
        code: 'OPENCODE_UPGRADE_MANAGED_BY_OPENCHAMBER',
        error: 'OpenCode is bundled with OpenChamber Desktop and updates with the app.',
      });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('never announces a newer version for a bundled binary: it updates with the desktop app', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      if (String(url).includes('registry.npmjs.org')) return jsonResponse({ version: '2.0.3' });
      if (String(url).includes('api.github.com')) return jsonResponse({ tag_name: 'v2.0.3' });
      return jsonResponse({ version: '1.18.8', pid: 1, urls: [], paths: { tmp: '/tmp' } });
    });
    const { app } = createApp();

    const response = await request(app)
      .get('/api/opencode/upgrade-status')
      .expect(200);

    expect(response.body).toEqual({
      available: false,
      currentVersion: '1.18.8',
      latestVersion: null,
      upgrade: {
        supported: false,
        manager: 'openchamber',
        reason: 'bundled',
      },
    });
  });

  it('does not upgrade a selected CLI or restart its server', async () => {
    globalThis.fetch = vi.fn();
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => supportedCapability });
    await request(app).post('/api/opencode/upgrade').send({ target: 'ignored', binary: 'ignored' })
      .expect(409);
    expect(dependencies.upgradeOpenCodeCli).not.toHaveBeenCalled();
    expect(dependencies.refreshOpenCodeAfterConfigChange).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(['external', 'unavailable'])('rejects %s on the server', async (reason) => {
    const { app, dependencies } = createApp({ getOpenCodeUpgradeCapability: () => ({ supported: false, reason }) });
    await request(app).post('/api/opencode/upgrade').send({}).expect(409);
    expect(dependencies.upgradeOpenCodeCli).not.toHaveBeenCalled();
  });

});

describe('OpenCode v1 migration routes', () => {
  it('rejects external, bundled and unsupported runtimes before running an installer', async () => {
    for (const installation of ['external', 'bundled', 'managed']) {
      const installOpenCodeV2 = vi.fn();
      const { app } = createApp({
        getOpenCodeCompatibility: async () => ({ state: 'incompatible', version: '1.18.30', installation, canInstall: false }),
        installOpenCodeV2,
      });
      await request(app).post('/api/opencode/install-v2').send({ binary: '/untrusted', command: 'untrusted' }).expect(409);
      expect(installOpenCodeV2).not.toHaveBeenCalled();
    }
  });

  it('refuses even when an old host advertises automatic installation', async () => {
    const installOpenCodeV2 = vi.fn();
    const { app } = createApp({
      getOpenCodeCompatibility: async () => ({ state: 'incompatible', version: '1.18.30', installation: 'managed', canInstall: true }),
      installOpenCodeV2,
    });
    await request(app).post('/api/opencode/install-v2').expect(409);
    expect(installOpenCodeV2).not.toHaveBeenCalled();
  });
});
