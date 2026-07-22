import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createArchiveStore } from './archive-store.js';
import { createOpenCodeSessionArchive, createSessionArchive } from './session-archive.js';

const tempDirs = [];

const makeStore = (entries) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-session-archive-'));
  tempDirs.push(dataDir);
  if (entries) fs.writeFileSync(path.join(dataDir, 'sessions-archive.json'), JSON.stringify(entries));
  return createArchiveStore({ dataDir });
};

afterEach(() => {
  while (tempDirs.length > 0) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  vi.restoreAllMocks();
});

const tagged = (tag) => Object.assign(new Error(tag), { _tag: tag });

/**
 * OpenCode as `session-archive.js` sees it. Sessions live in `/live` (running)
 * unless `places` says otherwise; a session in a `deleted` directory answers
 * LocationNotFoundError until it moves; `failures` maps a session to an error
 * tag for every call; project `proj` has its main folder at `/repo`.
 */
const fakeOpenCode = ({ failures = {}, archived = {}, places = {}, deleted = [], loaded = ['/live'], folders = { proj: '/repo' } } = {}) => {
  const state = { ...archived };
  const where = new Map(Object.entries(places));
  const log = [];
  const placeOf = (id) => where.get(id) ?? { directory: '/live', projectID: 'proj' };
  return {
    state,
    log,
    setArchived: vi.fn(async (id, value) => {
      if (failures[id]) throw tagged(failures[id]);
      if (deleted.includes(placeOf(id).directory)) throw tagged('LocationNotFoundError');
      log.push(['set', id, value]);
      state[id] = value ? 1 : null;
    }),
    move: vi.fn(async (id, directory) => {
      log.push(['move', id, directory]);
      where.set(id, { ...placeOf(id), directory });
    }),
    unload: vi.fn(async () => undefined),
    listLoadedDirectories: vi.fn(async () => loaded),
    readProjectFolders: vi.fn(async () => new Map(Object.entries(folders))),
    readPlace: vi.fn(async (id) => (failures[id] === 'SessionNotFoundError' ? undefined : placeOf(id))),
    readArchivedAt: vi.fn(async (id) => {
      if (failures[id] === 'Unavailable') throw tagged('Unavailable');
      return id in state ? state[id] : undefined;
    }),
  };
};

describe('session archive', () => {
  it('uses global session operations for archive, restore and confirmation', async () => {
    const session = { update: vi.fn(async () => undefined), get: vi.fn(async () => ({ time: { archived: 42 } })) };
    const clientFor = vi.fn(() => ({ session }));
    const openCode = createOpenCodeSessionArchive({ clientFor });
    await openCode.setArchived('ses_deleted_directory', true);
    await expect(openCode.readArchivedAt('ses_deleted_directory')).resolves.toBe(42);
    await openCode.setArchived('ses_deleted_directory', false);
    expect(session.update.mock.calls).toEqual([
      [{ sessionID: 'ses_deleted_directory', archived: true }],
      [{ sessionID: 'ses_deleted_directory', archived: false }],
    ]);
    expect(clientFor.mock.calls).toEqual([[], [], []]);
  });

  it('limits a batch to four writes and keeps result order across an individual failure', async () => {
    const openCode = fakeOpenCode();
    const releases = [];
    let active = 0;
    let peak = 0;
    openCode.setArchived.mockImplementation(async (id) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      if (id === 'ses_2') throw tagged('SessionNotFoundError');
      openCode.state[id] = 100 + Number(id.slice(4));
    });
    const archive = createSessionArchive({ store: makeStore(), openCode });
    const ids = Array.from({ length: 9 }, (_, index) => `ses_${index}`);
    const writing = archive.archive(ids);
    await vi.waitFor(() => expect(releases).toHaveLength(4));
    expect(openCode.setArchived).toHaveBeenCalledTimes(4);
    for (let index = 0; index < ids.length; index += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(index));
      releases[index]();
    }
    await expect(writing).resolves.toEqual({
      archived: ids.filter((id) => id !== 'ses_2').map((id) => ({ id, archivedAt: 100 + Number(id.slice(4)) })),
      failedIds: ['ses_2'],
    });
    expect(peak).toBe(4);
  });

  it('reports the backend timestamp and leaves archive announcements to OpenCode', async () => {
    const store = makeStore();
    const announce = vi.fn();
    const openCode = fakeOpenCode();
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.archive(['ses_a'], 1700)).resolves.toEqual({ archived: [{ id: 'ses_a', archivedAt: 1 }], failedIds: [] });
    expect(openCode.state.ses_a).toBe(1);
    expect(announce).not.toHaveBeenCalled();
  });

  it('retires a legacy entry after a confirmed restore without an overlay event', async () => {
    const store = makeStore({ ses_a: 500 });
    const announce = vi.fn();
    const archive = createSessionArchive({ store, openCode: fakeOpenCode(), announce });

    await archive.unarchive(['ses_a']);
    await expect(store.getAll()).resolves.toEqual({});
    expect(announce).not.toHaveBeenCalled();
  });

  it('reports a backend refusal without moving the session or creating an archive overlay', async () => {
    const store = makeStore();
    const announce = vi.fn();
    const openCode = fakeOpenCode({ places: { ses_wt: { directory: '/repo-wt', projectID: 'proj' } }, deleted: ['/repo-wt'] });
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.archive(['ses_wt'])).resolves.toEqual({ archived: [], failedIds: ['ses_wt'] });
    expect(announce).not.toHaveBeenCalled();
    expect(openCode.move).not.toHaveBeenCalled();
    await expect(store.getAll()).resolves.toEqual({});
  });

  it('restores by ID without reading or changing session placement', async () => {
    const store = makeStore({ ses_wt: 500, ses_orphan: 600 });
    const announce = vi.fn();
    const openCode = fakeOpenCode({
      places: { ses_wt: { directory: '/repo-wt', projectID: 'proj' }, ses_orphan: { directory: '/gone', projectID: 'gone_proj' } },
    });
    const archive = createSessionArchive({ store, openCode, announce });

    await expect(archive.unarchive(['ses_wt', 'ses_orphan'])).resolves.toEqual({
      restored: [{ id: 'ses_wt', archivedAt: null }, { id: 'ses_orphan', archivedAt: null }],
      failedIds: [],
    });
    expect(openCode.move).not.toHaveBeenCalled();
    expect(openCode.readPlace).not.toHaveBeenCalled();
    expect(openCode.log).toContainEqual(['set', 'ses_wt', false]);
    await expect(store.getAll()).resolves.toEqual({});
    expect(announce).not.toHaveBeenCalled();
  });

  it('migrates legacy flags without loading locations and retains failed entries', async () => {
    const store = makeStore({ ses_live: 100, ses_restored: null, ses_closed: 200, ses_wt: 300, ses_missing: 400, ses_flaky: 500 });
    const openCode = fakeOpenCode({
      places: {
        ses_closed: { directory: '/closed', projectID: 'proj' },
        ses_wt: { directory: '/repo-wt', projectID: 'proj' },
      },
      failures: { ses_missing: 'SessionNotFoundError', ses_flaky: 'UnknownError' },
      loaded: ['/live'],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode });

    await expect(archive.migrateLegacy()).resolves.toBe(1);

    expect(openCode.log).toEqual(expect.arrayContaining([
      ['set', 'ses_live', true],
      ['set', 'ses_restored', false],
      ['set', 'ses_closed', true],
      ['set', 'ses_wt', true],
    ]));
    expect(openCode.unload).not.toHaveBeenCalled();
    expect(openCode.listLoadedDirectories).not.toHaveBeenCalled();
    expect(openCode.readPlace).not.toHaveBeenCalled();
    await expect(store.getAll()).resolves.toEqual({ ses_flaky: 500 });
  });

  it('does not let a migration push land after the user changed the session', async () => {
    const store = makeStore({ ses_a: 100 });
    let release;
    const openCode = fakeOpenCode();
    openCode.setArchived.mockImplementationOnce(async (id, value) => {
      await new Promise((resolve) => { release = resolve; });
      openCode.state[id] = value ? 1 : null;
    });
    const archive = createSessionArchive({ store, openCode });

    const restoring = archive.unarchive(['ses_a']);
    const migrating = archive.migrateLegacy();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    release();
    await expect(restoring).resolves.toEqual({ restored: [{ id: 'ses_a', archivedAt: null }], failedIds: [] });
    await expect(migrating).resolves.toBe(0);

    // The migration found the entry gone and pushed nothing of its own.
    expect(openCode.setArchived.mock.calls).toEqual([['ses_a', false]]);
    expect(openCode.state.ses_a).toBeNull();
  });

  it('reads only backend archive facts and rejects unknown state', async () => {
    const store = makeStore({ ses_file: 500, ses_restored: null });
    const openCode = fakeOpenCode({ archived: { ses_upstream: 900, ses_restored: 800 }, failures: { ses_down: 'Unavailable' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const archive = createSessionArchive({ store, openCode });

    await expect(archive.archivedAt('ses_file')).rejects.toThrow('not found');
    await expect(archive.archivedAt('ses_restored')).resolves.toBe(800);
    await expect(archive.archivedAt('ses_upstream')).resolves.toBe(900);
    await expect(archive.isArchived('ses_unknown')).rejects.toThrow('not found');
    await expect(archive.isArchived('ses_down')).rejects.toThrow('Unavailable');
    expect(openCode.readArchivedAt).toHaveBeenCalledWith('ses_file');
  });
});
