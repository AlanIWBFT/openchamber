import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { clearLogin, instanceDb, loginSource, seedLogin } from './database.mjs';

test('only selected fixture rows reach the bench; cleanup leaves the source alone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-db-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { XDG_DATA_HOME: path.join(root, "test user's data") };
  const db = instanceDb({ data: path.join(root, 'isolated') });
  const source = path.join(env.XDG_DATA_HOME, 'opencode/opencode-dev.db');
  for (const filename of [source, db]) fs.mkdirSync(path.dirname(filename), { recursive: true });
  const sql = (filename, stmt) => execFileSync('sqlite3', [filename, stmt], { encoding: 'utf8', windowsHide: true }).trim();
  assert.throws(() => loginSource(env), /No login database/);
  for (const filename of [source, db]) sql(filename, 'create table credential(integration_id text primary key)');
  sql(source, "insert into credential values ('selected'), ('other')");
  const uri = loginSource(env);
  assert.equal(loginSource({ OPENCHAMBER_BENCH_LOGIN_DB: source }), uri);
  assert.notEqual(spawnSync('sqlite3', [db, `attach '${uri.replaceAll("'", "''")}' as real; delete from real.credential;`], { stdio: 'ignore', windowsHide: true }).status, 0);
  assert.equal(seedLogin(db, uri, ['selected']), true);
  assert.equal(sql(db, 'select integration_id from credential'), 'selected');
  assert.equal(clearLogin(db), true);
  assert.equal(sql(db, 'select count(*) from credential'), '0');
  assert.equal(sql(source, 'select count(*) from credential'), '2');
});
