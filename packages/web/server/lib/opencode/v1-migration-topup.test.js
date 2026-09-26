import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { computeResumeCursor, resolveOpenCodeDbPath, topUpV1Migration } from './v1-migration-topup.js';

it('resolves the local dev database while preserving explicit channel, XDG and memory overrides', () => {
  const root = path.resolve(os.tmpdir(), 'migration-path-test');
  expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: root })).toBe(path.join(root, 'opencode', 'opencode-dev.db'));
  for (const flag of ['1', 'true']) {
    expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: root, OPENCODE_DISABLE_CHANNEL_DB: flag })).toBe(path.join(root, 'opencode', 'opencode.db'));
  }
  expect(resolveOpenCodeDbPath({ XDG_DATA_HOME: root, OPENCODE_DB: 'custom.db' })).toBe(path.join(root, 'opencode', 'custom.db'));
  expect(resolveOpenCodeDbPath({ OPENCODE_DB: path.join(root, 'absolute.db') })).toBe(path.join(root, 'absolute.db'));
  expect(resolveOpenCodeDbPath({ OPENCODE_DB: ':memory:' })).toBe(':memory:');
});

const sqlite = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return null;
  }
})();

const MIGRATION_KEY = 'migration.v1-v2';
/** Stands in for "when OpenCode finished the migration". */
const COMPLETED_AT = 1_000_000;

let dir;
let dbPath;

const openDb = () => new sqlite.DatabaseSync(dbPath);

/**
 * Build a database with the tables the top-up reads, in OpenCode's shape.
 * `options.tables` drops tables to cover half-built databases.
 */
const createDatabase = ({ tables = ['session', 'session_v2', 'session_message', 'kv', 'event'] } = {}) => {
  const db = openDb();
  if (tables.includes('session')) {
    db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, time_created INTEGER, time_updated INTEGER)');
  }
  if (tables.includes('session_v2')) {
    db.exec('CREATE TABLE session_v2 (id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER)');
  }
  if (tables.includes('session_message')) {
    db.exec(
      'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER)',
    );
  }
  if (tables.includes('kv')) {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, time_created INTEGER, time_updated INTEGER)');
  }
  if (tables.includes('event')) {
    db.exec('CREATE TABLE event (id TEXT PRIMARY KEY, payload TEXT)');
  }
  db.close();
};

/**
 * `v1` entries are ids or `{ id, timeCreated }`. A bare id stands for a session
 * created after the migration completed (the case the top-up exists for); a
 * session the migration already walked needs `timeCreated` before COMPLETED_AT.
 */
const seed = ({ v1 = [], v2 = [], messages = [], migration = { phase: 'completed' } } = {}) => {
  const db = openDb();
  for (const entry of v1) {
    const { id, timeCreated = COMPLETED_AT + 1 } = typeof entry === 'string' ? { id: entry } : entry;
    db.prepare('INSERT INTO session (id, project_id, time_created, time_updated) VALUES (?, ?, ?, ?)').run(
      id,
      'prj',
      timeCreated,
      timeCreated,
    );
  }
  for (const session of v2) {
    db.prepare('INSERT INTO session_v2 (id, time_created, time_updated) VALUES (?, ?, ?)').run(
      session.id,
      1,
      session.timeUpdated ?? COMPLETED_AT - 500,
    );
  }
  for (const [index, message] of messages.entries()) {
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`msg_${index}`, message.session, message.type, index, message.timeCreated ?? COMPLETED_AT - 500, 1);
  }
  if (migration) {
    db.prepare('INSERT INTO kv (key, value, time_created, time_updated) VALUES (?, ?, ?, ?)').run(
      MIGRATION_KEY,
      JSON.stringify(migration),
      1,
      COMPLETED_AT,
    );
  }
  db.close();
};

const readMigrationRow = () => {
  const db = openDb();
  const row = db.prepare('SELECT value, time_updated FROM kv WHERE key = ?').all(MIGRATION_KEY)[0];
  db.close();
  return row ? { state: JSON.parse(row.value), timeUpdated: row.time_updated } : null;
};

const countEvents = () => {
  const db = openDb();
  const count = db.prepare('SELECT COUNT(*) AS value FROM event').all()[0].value;
  db.close();
  return count;
};

const run = () => topUpV1Migration({ dbPath, logger: { log: () => {}, warn: () => {} }, now: () => 2_000_000 });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-topup-'));
  dbPath = path.join(dir, 'opencode.db');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('computeResumeCursor', () => {
  it('sorts immediately above the id it must reach', () => {
    const cursor = computeResumeCursor('ses_b');
    expect(cursor > 'ses_b').toBe(true);
    // No same-length id can fall between the id and the cursor.
    expect(cursor > 'ses_c').toBe(false);
  });
});

describe.skipIf(!sqlite)('topUpV1Migration', () => {
  it.each([
    [undefined, undefined, 'opencode-dev.db'],
    [undefined, '1', 'opencode.db'],
    ['custom.db', '1', 'custom.db'],
  ])('updates only the configured database in XDG_DATA_HOME: %s / %s', async (configured, disableChannel, expectedFile) => {
    vi.stubEnv('XDG_DATA_HOME', dir);
    vi.stubEnv('OPENCODE_DB', configured);
    vi.stubEnv('OPENCODE_DISABLE_CHANNEL_DB', disableChannel);
    fs.mkdirSync(path.join(dir, 'opencode'));
    const filenames = ['opencode.db', 'opencode-dev.db', 'custom.db'];
    for (const filename of filenames) {
      dbPath = path.join(dir, 'opencode', filename);
      createDatabase();
      seed({ v1: ['ses_a'] });
    }
    vi.resetModules();
    const migration = await import('./v1-migration-topup.js');
    expect(migration.topUpV1Migration({ logger: { log: () => {}, warn: () => {} } }))
      .toEqual({ status: 'scheduled', missing: 1, revisited: 0 });
    for (const filename of filenames) {
      dbPath = path.join(dir, 'opencode', filename);
      expect(readMigrationRow().state).toEqual(filename === expectedFile
        ? { phase: 'sessions', cursor: computeResumeCursor('ses_a') }
        : { phase: 'completed' });
    }
  });

  it('skips :memory: without looking for a file', () => {
    expect(topUpV1Migration({ dbPath: ':memory:', fileSystem: { existsSync: () => { throw new Error('unexpected file access'); } } }))
      .toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' });
  });

  it('skips when the database file does not exist', () => {
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-database' });
  });

  it('skips a database without the v1 session table', () => {
    createDatabase({ tables: ['session_v2', 'session_message', 'kv', 'event'] });
    seed({ v1: [] });
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'no-v1-sessions' });
  });

  it('skips when the migration row is absent, and never clears it', () => {
    createDatabase();
    seed({ v1: ['ses_a'], migration: null });
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'migration-not-completed' });
    expect(readMigrationRow()).toBeNull();
  });

  it('skips while OpenCode is still migrating', () => {
    createDatabase();
    seed({ v1: ['ses_a'], migration: { phase: 'sessions', cursor: 'ses_b' } });
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'migration-not-completed' });
    expect(readMigrationRow().state).toEqual({ phase: 'sessions', cursor: 'ses_b' });
  });

  it('does nothing when every v1 session is already in v2', () => {
    createDatabase();
    seed({ v1: ['ses_a', 'ses_b'], v2: [{ id: 'ses_a' }, { id: 'ses_b' }] });
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'nothing-missing' });
    expect(readMigrationRow().state).toEqual({ phase: 'completed' });
  });

  it('schedules a cursor for missing sessions when nothing would be revisited', () => {
    createDatabase();
    seed({ v1: ['ses_c', 'ses_d'], v2: [] });
    expect(run()).toEqual({ status: 'scheduled', missing: 2, revisited: 0 });
    expect(readMigrationRow()).toEqual({
      state: { phase: 'sessions', cursor: computeResumeCursor('ses_d') },
      timeUpdated: 2_000_000,
    });
  });

  it('schedules when the sessions it will revisit were never touched in v2', () => {
    createDatabase();
    seed({
      v1: ['ses_a', 'ses_d'],
      v2: [{ id: 'ses_a' }],
      messages: [{ session: 'ses_a', type: 'user' }, { session: 'ses_a', type: 'assistant' }],
    });
    expect(run()).toEqual({ status: 'scheduled', missing: 1, revisited: 1 });
    expect(readMigrationRow().state).toEqual({ phase: 'sessions', cursor: computeResumeCursor('ses_d') });
  });

  it('refuses when a revisited session gained a message after the migration finished', () => {
    createDatabase();
    seed({
      v1: ['ses_a', 'ses_d'],
      v2: [{ id: 'ses_a' }],
      messages: [{ session: 'ses_a', type: 'user', timeCreated: COMPLETED_AT + 1 }],
    });
    expect(run()).toEqual({
      status: 'unsafe',
      missing: 1,
      revisited: 1,
      reason: 'revisited-sessions-have-v2-activity',
    });
    expect(readMigrationRow().state).toEqual({ phase: 'completed' });
  });

  it('refuses when a revisited session carries a message type the v1 import never produces', () => {
    createDatabase();
    seed({
      v1: ['ses_a', 'ses_d'],
      v2: [{ id: 'ses_a' }],
      messages: [{ session: 'ses_a', type: 'shell' }],
    });
    expect(run().status).toBe('unsafe');
    expect(readMigrationRow().state).toEqual({ phase: 'completed' });
  });

  it('refuses when a revisited session row was updated after the migration finished', () => {
    createDatabase();
    seed({ v1: ['ses_a', 'ses_d'], v2: [{ id: 'ses_a', timeUpdated: COMPLETED_AT + 10 }] });
    expect(run().status).toBe('unsafe');
    expect(readMigrationRow().state).toEqual({ phase: 'completed' });
  });

  it('handles wrapped session ids: the cursor comes from the largest missing id', () => {
    // Real ids wrap, so a 2026-08 session (`ses_002f…`) sorts far below a
    // newer one (`ses_f4b7…`). The migrated low session is below the cursor
    // and therefore counted as revisited.
    createDatabase();
    seed({
      v1: ['ses_002fb287fffe', 'ses_f4b70000aaaa'],
      v2: [{ id: 'ses_002fb287fffe' }],
      messages: [{ session: 'ses_002fb287fffe', type: 'user' }],
    });
    expect(run()).toEqual({ status: 'scheduled', missing: 1, revisited: 1 });
    expect(readMigrationRow().state).toEqual({
      phase: 'sessions',
      cursor: computeResumeCursor('ses_f4b70000aaaa'),
    });
  });

  it('does not bring back a session deleted in v2 when 1.x was not used since', () => {
    // ses_a was imported and then deleted in v2: only its legacy row is left,
    // untouched since the last completed import.
    createDatabase();
    seed({ v1: [{ id: 'ses_a', timeCreated: COMPLETED_AT - 1 }] });
    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'nothing-missing' });
    expect(readMigrationRow().state).toEqual({ phase: 'completed' });
  });

  it('imports only sessions 1.x changed since the last import, cursor included', () => {
    // ses_z (deleted in v2, old) sorts above ses_d (fresh from 1.x): the
    // cursor must stop at ses_d so ses_z stays gone.
    createDatabase();
    seed({ v1: [{ id: 'ses_z', timeCreated: COMPLETED_AT - 1 }, 'ses_d'] });
    expect(run()).toEqual({ status: 'scheduled', missing: 1, revisited: 0 });
    expect(readMigrationRow().state).toEqual({ phase: 'sessions', cursor: computeResumeCursor('ses_d') });
  });

  it('never touches the durable event log', () => {
    createDatabase();
    const db = openDb();
    db.prepare('INSERT INTO event (id, payload) VALUES (?, ?)').run('evt_1', '{}');
    db.close();
    seed({ v1: ['ses_d'] });
    expect(run().status).toBe('scheduled');
    expect(countEvents()).toBe(1);
  });

  it('skips on a second run, once OpenCode has imported the sessions', () => {
    createDatabase();
    seed({ v1: ['ses_d'] });
    expect(run().status).toBe('scheduled');

    // OpenCode runs, imports ses_d and marks the migration completed again.
    const db = openDb();
    db.prepare('INSERT INTO session_v2 (id, time_created, time_updated) VALUES (?, ?, ?)').run('ses_d', 1, 2_000_100);
    db.prepare('UPDATE kv SET value = ?, time_updated = ? WHERE key = ?').run(
      JSON.stringify({ phase: 'completed' }),
      2_000_200,
      MIGRATION_KEY,
    );
    db.close();

    expect(run()).toEqual({ status: 'skipped', missing: 0, revisited: 0, reason: 'nothing-missing' });
  });
});
