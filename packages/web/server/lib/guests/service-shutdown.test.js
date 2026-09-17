import { expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { invalidateGuestCatalog } from './catalog.js';
import { setCapabilityGrants, writeExtensionPaths } from './persist.js';
import { registerGuestRoutes } from './routes.js';
import { getServiceStatus, proxyGuestServiceRequest, readServicePid, stopAllGuestServices } from './service.js';
import { createShutdownFence } from '../opencode/shutdown-runtime.js';

// Host shutdown is terminal; this file's isolated runtime owns the whole lifecycle.
test('host shutdown rejects a route still loading its guest, while ordinary stop permits restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-service-shutdown-'));
  const packageRoot = path.join(dir, 'fixture');
  const persistPath = path.join(dir, 'extensions.json');
  const id = 'shutdown-fixture';
  let stopping = false;
  let stopAfterDispatch = false;
  let cleanup = Promise.resolve();
  try {
    await fs.mkdir(packageRoot);
    await fs.writeFile(path.join(packageRoot, 'index.html'), '<p>Fixture</p>');
    await fs.writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
      name: 'shutdown-fixture', version: '1.0.0', type: 'module',
      openchamber: { apiVersion: 1, contributes: {
        panel: { id, name: 'Fixture', icon: 'window', entry: 'index.html' },
        service: { entry: 'service.mjs', runtime: 'host' },
      } },
    }));
    await fs.writeFile(path.join(packageRoot, 'service.mjs'), `
import http from 'node:http';
import fs from 'node:fs';
fs.appendFileSync('starts', 'started\\n');
http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + process.env.OPENCHAMBER_SERVICE_TOKEN) {
    res.writeHead(401); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"pong":true}');
}).listen(Number(process.env.OPENCHAMBER_SERVICE_PORT), '127.0.0.1');
`);
    await writeExtensionPaths([packageRoot], persistPath);
    await setCapabilityGrants(id, persistPath, ['service'], { service: { exec: [], sockets: [] } });
    const app = express();
    app.use(express.json());
    app.use(createShutdownFence(() => stopping));
    app.use((_req, _res, next) => {
      next();
      // The real route has entered await loadGuest(), but has not called the service proxy.
      if (stopAfterDispatch) {
        stopping = true;
        cleanup = stopAllGuestServices({ shutdown: true });
      }
    });
    registerGuestRoutes(app, {
      openchamberDataDir: dir, openchamberVersion: '1.24.0',
      resolveGitBinaryForSpawn: () => 'git',
    });
    const send = () => request(app).post(`/api/guests/${id}/service/request`).send({ method: 'GET', path: '/ping' });

    for (let run = 0; run < 2; run += 1) {
      await send().expect(200);
      expect(readServicePid(id)).toBeGreaterThan(0);
      await stopAllGuestServices();
      expect(getServiceStatus(id)).toBe('stopped');
    }
    const starts = await fs.readFile(path.join(packageRoot, 'starts'), 'utf8');
    expect(starts).toBe('started\nstarted\n');

    invalidateGuestCatalog(persistPath);
    stopAfterDispatch = true;
    const response = await send().expect(400);
    await cleanup;
    expect(response.body).toMatchObject({ error: 'NO_SERVICE', message: 'The host is shutting down.' });
    expect(readServicePid(id)).toBeNull();
    expect(await fs.readFile(path.join(packageRoot, 'starts'), 'utf8')).toBe(starts);
    await send().expect(503);
    await stopAllGuestServices();
    await expect(proxyGuestServiceRequest({
      guestId: id, packageRoot, service: { entry: 'service.mjs' }, granted: ['service'],
      persistPath, method: 'GET', path: '/ping',
    })).rejects.toMatchObject({ code: 'NO_SERVICE', message: 'The host is shutting down.' });
  } finally {
    await cleanup;
    await stopAllGuestServices();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
