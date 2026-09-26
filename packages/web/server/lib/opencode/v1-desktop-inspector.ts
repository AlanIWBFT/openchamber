import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import type { LegacySessionAdvice } from './v1-desktop-notice.js';

export function inspectLegacySessions(dbPath: string): LegacySessionAdvice | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('session')) return null;
    const state = tables.has('kv') ? db.prepare('SELECT value, time_updated FROM kv WHERE key = ?').get('migration.v1-v2') : undefined;
    const completed = typeof state?.value === 'string' && JSON.parse(state.value)?.phase === 'completed';
    const predicates: string[] = [];
    if (tables.has('session_v2')) predicates.push('NOT EXISTS (SELECT 1 FROM session_v2 v WHERE v.id = s.id)');
    if (completed) predicates.push('s.time_updated > ?');
    const missing = db.prepare(`SELECT 1 FROM session s ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''} LIMIT 1`)
      .get(...(completed && typeof state?.time_updated === 'number' ? [state.time_updated] : []));
    if (!missing) return null;
    if (state) return 'backup';
    for (const table of ['session_v2', 'session_message', 'event']) {
      if (tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) return 'backup';
    }
    return 'standalone';
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

if (parentPort && typeof workerData === 'string') parentPort.postMessage(inspectLegacySessions(workerData));
