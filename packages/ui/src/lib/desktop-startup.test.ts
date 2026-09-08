import { describe, expect, test } from 'bun:test';
import { createDesktopStartupReadiness, isDesktopStartupLocalTarget } from './desktop-startup';

describe('desktop startup target identification', () => {
  const local = 'http://127.0.0.1:3901';
  const proxy = 'http://127.0.0.1:5173';

  test('recognizes empty, relative and absolute HMR proxy targets', () => {
    for (const target of ['', '/api', `${proxy}/api`]) {
      expect(isDesktopStartupLocalTarget(target, local, proxy, `${proxy}/`)).toBe(true);
    }
    expect(isDesktopStartupLocalTarget(`${local}/api`, local, proxy, `${proxy}/`)).toBe(true);
  });

  test('does not guess that arbitrary UI or loopback origins are the local backend', () => {
    expect(isDesktopStartupLocalTarget('/api', local, '', `${proxy}/`)).toBe(false);
    expect(isDesktopStartupLocalTarget('http://127.0.0.1:9999/api', local, proxy, `${proxy}/`)).toBe(false);
    expect(isDesktopStartupLocalTarget('https://remote.example/api', local, proxy, `${proxy}/`)).toBe(false);
  });

  test('supports packaged local and remote windows and serverless startup', () => {
    const page = 'openchamber-ui://app/index.html';
    expect(isDesktopStartupLocalTarget(`${local}/api`, local, '', page)).toBe(true);
    expect(isDesktopStartupLocalTarget('https://remote.example/api', local, '', page)).toBe(false);
    expect(isDesktopStartupLocalTarget('', '', '', page)).toBe(false);
  });
});

describe('desktop startup request readiness', () => {
  test('keeps reads pending through migration and finalization without polling', async () => {
    const startup = createDesktopStartupReadiness();
    let finished = 0;
    const reads = Array.from({ length: 20 }, () => startup.wait().then(() => { finished++; }));
    startup.update({ phase: 'migrating', revision: 1 });
    await Promise.resolve();
    expect(finished).toBe(0);
    startup.update({ phase: 'finalizing', revision: 2 });
    await Promise.resolve();
    expect(finished).toBe(0);
    startup.update({ phase: 'ready', revision: 3 });
    await Promise.all(reads);
    expect(finished).toBe(20);
  });

  test('a replayed bootstrap snapshot cannot overwrite a newer IPC event', async () => {
    const startup = createDesktopStartupReadiness();
    startup.update({ phase: 'ready', revision: 3 });
    startup.update({ phase: 'migrating', revision: 1 });
    await startup.wait();
    expect(startup.getState().phase).toBe('ready');
  });

  test('failure rejects existing and subsequent reads', async () => {
    const startup = createDesktopStartupReadiness();
    const pending = startup.wait();
    startup.update({ phase: 'failed', revision: 1 });
    await expect(pending).rejects.toThrow('Restart OpenChamber');
    await expect(startup.wait()).rejects.toThrow('Restart OpenChamber');
    startup.update({ phase: 'ready', revision: 2 });
    await expect(startup.wait()).rejects.toThrow('Restart OpenChamber');
  });

  test('cancellation affects only its caller and never cancels startup', async () => {
    const startup = createDesktopStartupReadiness();
    const abort = new AbortController();
    const pending = startup.wait(abort.signal);
    const retained = startup.wait();
    abort.abort();
    await expect(pending).rejects.toThrow('Request cancelled');
    startup.update({ phase: 'ready', revision: 1 });
    await retained;
    await expect(startup.wait(abort.signal)).rejects.toThrow('Request cancelled');
  });

  test('runtime switching rejects the old request before it can use new credentials', async () => {
    const startup = createDesktopStartupReadiness();
    const events = new EventTarget();
    const pending = startup.wait(undefined, events);
    events.dispatchEvent(new Event('openchamber:runtime-endpoint-will-change'));
    await expect(pending).rejects.toThrow('Runtime changed during startup');
    startup.update({ phase: 'ready', revision: 1 });
    await startup.wait();
  });

  test('rejects malformed IPC state at the boundary', () => {
    const startup = createDesktopStartupReadiness();
    expect(() => startup.update(JSON.parse('{"phase":"perhaps-ready","revision":1}'))).toThrow();
  });
});
