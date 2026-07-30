import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const instanceDb = (dirs) => path.join(dirs.data, 'opencode/opencode-dev.db');

export const loginSource = (env = process.env) => {
  const source = env.OPENCHAMBER_BENCH_LOGIN_DB || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share'), 'opencode/opencode-dev.db');
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw new Error(`No login database at ${source}; set OPENCHAMBER_BENCH_LOGIN_DB to the database you signed in with`);
  const uri = pathToFileURL(path.resolve(source));
  uri.searchParams.set('mode', 'ro');
  return uri.href;
};

const literal = (value) => `'${value.replaceAll("'", "''")}'`;
export const seedLogin = (db, source, providers) => spawnSync('sqlite3', [db,
  `attach ${literal(source)} as real; insert or ignore into credential select * from real.credential where integration_id in (${providers.map(literal).join(',')});`,
], { stdio: 'ignore', windowsHide: true }).status === 0;

export const clearLogin = (db) => spawnSync('sqlite3', [db, 'delete from credential;'], { stdio: 'ignore', windowsHide: true }).status === 0;
