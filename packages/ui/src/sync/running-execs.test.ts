import { beforeEach, expect, test } from 'bun:test';
import type { RunningExec } from '@/lib/opencode/exec-metadata';
import type { SyncEvent } from '@/lib/opencode/events';
import { applyRunningExecEvents, refreshRunningExecs, resetRunningExecs, useRunningExecsStore } from './running-execs';

const command = (execID = 1): RunningExec => ({ execID, sessionID: 'ses_root', command: 'watch', startedAt: 100 });
const update = (running: boolean, live = true, sessionExposed = true): SyncEvent => ({
  type: 'message.tool.transition', properties: {
    sessionID: 'ses_root', messageID: 'msg_1', partID: 'call_1',
    transition: { kind: 'exec', live, revision: 1, metadata: { ...command(), processRunning: running, sessionExposed } },
  },
});
beforeEach(resetRunningExecs);

test('refreshes requested during a read share a fresh trailing read', async () => {
  let resolve!: (value: RunningExec[]) => void;
  let reads = 0;
  const stale = refreshRunningExecs(() => new Promise((done) => { resolve = done; }));
  const list = async () => { reads++; return []; };
  const reconnect = refreshRunningExecs(list);
  const repeated = refreshRunningExecs(list);
  resolve([command()]);
  await Promise.all([stale, reconnect, repeated]);
  expect(reads).toBe(1);
  expect(useRunningExecsStore.getState().byId.size).toBe(0);
});

test('a failed old read still allows the queued refresh', async () => {
  let reject!: (error: Error) => void;
  const old = refreshRunningExecs(() => new Promise((_, fail) => { reject = fail; }));
  const observed = old.catch(() => undefined);
  const next = refreshRunningExecs(async () => [command()]);
  reject(new Error('offline'));
  await Promise.all([observed, next]);
  expect(useRunningExecsStore.getState().byId.size).toBe(1);
});

test('runtime reset discards queued refreshes from the old connection', async () => {
  let resolve!: (value: RunningExec[]) => void;
  let calls = 0;
  const old = refreshRunningExecs(() => new Promise((done) => { resolve = done; }));
  const queued = refreshRunningExecs(async () => { calls++; return [command()]; });
  resetRunningExecs();
  await refreshRunningExecs(async () => [command(2)]);
  resolve([command()]);
  await Promise.all([old, queued]);
  expect(calls).toBe(0);
  expect([...useRunningExecsStore.getState().byId.keys()]).toEqual([2]);
});

test('initial wait stays hidden until the running command is exposed', () => {
  applyRunningExecEvents([update(true, true, false)]);
  expect(useRunningExecsStore.getState().byId.size).toBe(0);
  applyRunningExecEvents([update(true)]);
  expect(useRunningExecsStore.getState().byId.size).toBe(1);
  applyRunningExecEvents([update(false)]);
  expect(useRunningExecsStore.getState().byId.size).toBe(0);
});

test('live commands outlast tool settlement; durable captures never resurrect commands', () => {
  applyRunningExecEvents([update(true)]);
  const state = useRunningExecsStore.getState();
  applyRunningExecEvents([update(true)]);
  expect(useRunningExecsStore.getState()).toBe(state);
  applyRunningExecEvents([update(false)]);
  applyRunningExecEvents([update(true, false)]);
  expect(useRunningExecsStore.getState().byId.size).toBe(0);
});

test('authoritative reads restore active commands and clear missed exits, failed reads preserve them', async () => {
  await refreshRunningExecs(async () => [command()]);
  await expect(refreshRunningExecs(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(useRunningExecsStore.getState().byId.size).toBe(1);
  await refreshRunningExecs(async () => []);
  expect(useRunningExecsStore.getState().byId.size).toBe(0);
});

test('events during a read win, including an exit for a command not yet in the index', async () => {
  let resolve!: (value: RunningExec[]) => void;
  const read = refreshRunningExecs(() => new Promise((done) => { resolve = done; }));
  applyRunningExecEvents([update(false)]);
  resolve([command(), command(2)]);
  await read;
  expect([...useRunningExecsStore.getState().byId.keys()]).toEqual([2]);
});

test('runtime switch rejects an old read and allows a new read immediately', async () => {
  let resolve!: (value: RunningExec[]) => void;
  const read = refreshRunningExecs(() => new Promise((done) => { resolve = done; }));
  resetRunningExecs();
  await refreshRunningExecs(async () => [command(2)]);
  resolve([command()]);
  await read;
  expect([...useRunningExecsStore.getState().byId.keys()]).toEqual([2]);
});
