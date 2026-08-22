import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import simpleGit from 'simple-git';
import { describe, expect, it } from 'vitest';
import { resolveGitBinary } from './git-binary.js';
import { execFileWithProcessBroker, getProcessBrokerSpawn } from './process-broker.js';

const broker = process.env.OPENCHAMBER_PROCESS_BROKER_PATH?.trim();
const available = process.platform === 'win32' && broker && fs.statSync(broker, { throwIfNoEntry: false })?.isFile();
const findBrokerPid = () => Number(execFileSync('pwsh', [
  '-Command',
  `(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'OpenCode.ProcessBroker.exe'" | Sort-Object CreationDate -Descending | Select-Object -First 1 -ExpandProperty ProcessId)`,
], { encoding: 'utf8' }).trim());

describe.runIf(available)('Windows process broker', () => {
  it('captures output and runs four commands concurrently', async () => {
    const run = (value) => execFileWithProcessBroker(process.execPath, ['-e', `process.stdout.write('${value}')`]);
    const results = await Promise.all(Array.from({ length: 4 }, (_, index) => run(index)));
    expect(results.map((result) => result.stdout).sort()).toEqual(['0', '1', '2', '3']);
  });

  it('reports non-zero exits with captured stderr', async () => {
    await expect(execFileWithProcessBroker(
      process.execPath,
      ['-e', "process.stderr.write('failed');process.exit(7)"],
    )).rejects.toMatchObject({ code: 7, stderr: 'failed' });
  });

  it('waits for process-tree close before rejecting a timed-out probe', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-broker-timeout-'));
    try {
      await expect(execFileWithProcessBroker(process.execPath, [
        '-e', "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});setInterval(()=>{},60000)",
      ], { cwd: directory, timeout: 500 })).rejects.toMatchObject({ code: 'ETIMEDOUT', killed: true });
      fs.rmdirSync(directory);
      await expect(execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('next')"], { timeout: 5000 }))
        .resolves.toEqual({ stdout: 'next', stderr: '' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['executable', 'cwd'])('isolates an unavailable %s from concurrent commands', async (kind) => {
    const missing = path.join(os.tmpdir(), `openchamber-broker-missing-${process.pid}`, 'missing');
    const results = await Promise.allSettled([
      execFileWithProcessBroker(kind === 'executable' ? missing : process.execPath, ['-e', ''], kind === 'cwd' ? { cwd: missing } : {}),
      execFileWithProcessBroker(process.execPath, ['-e', "setTimeout(()=>process.stdout.write('independent'),100)"]),
    ]);
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { stage: 'spawn', code: kind === 'cwd' ? 267 : 3 } });
    expect(results[1]).toEqual({ status: 'fulfilled', value: { stdout: 'independent', stderr: '' } });
    await expect(execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('next')"]))
      .resolves.toEqual({ stdout: 'next', stderr: '' });
  });

  it.each(['stdout', 'stderr'])('closes the command before rejecting a %s buffer overflow', async (stream) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-broker-overflow-'));
    try {
      await expect(execFileWithProcessBroker(process.execPath, [
        '-e', `process.${stream}.write(Buffer.alloc(4096));setInterval(()=>{},60000)`,
      ], { cwd: directory, maxBuffer: 1024 })).rejects.toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
      // A still-running Windows child holds its current directory open.
      fs.rmdirSync(directory);
      expect(await execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('next')"]))
        .toEqual({ stdout: 'next', stderr: '' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['completed', false, 11],
    ['unknown', false, 11],
    ['completed', true, 11],
    ['unknown', true, 11],
    ['completed', false, 5],
    ['unknown', false, 5],
    ['completed', false, 6],
    ['unknown', false, 6],
    ['completed', true, 6],
    ['unknown', true, 6],
  ])('handles a %s command with malformed payload=%s for frame %s', async (target, malformed, type) => {
    const spawn = getProcessBrokerSpawn();
    const completed = spawn(process.execPath, ['-e', 'process.stdin.resume()']);
    const completedClose = new Promise((resolve, reject) => {
      completed.once('error', reject);
      completed.once('close', resolve);
    });
    completed.stdin.on('error', () => {});
    completed.stdout.resume();
    completed.stderr.resume();
    completed.stdin.end();
    expect(await completedClose).toBe(0);

    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready:');process.stdin.pipe(process.stdout)"]);
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.resume();
    child.stdin.on('error', () => {});
    const closed = new Promise((resolve) => child.once('close', resolve));
    const outcome = new Promise((resolve) => {
      child.once('error', (error) => resolve({ error }));
      child.once('close', (code) => resolve({ code, stdout: Buffer.concat(output).toString() }));
    });
    try {
      await new Promise((resolve, reject) => {
        child.stdout.once('data', resolve);
        child.once('error', reject);
      });
      expect(child.client).toBe(completed.client);
      // Exercise late stdin/close/cancel frames after the command has been removed.
      const id = target === 'completed' ? completed.id : completed.id + 1_000_000n;
      child.client.write(type, id, malformed || type === 5 ? Buffer.from([1]) : Buffer.alloc(0));
      child.stdin.end('independent');
      const result = await outcome;
      if (malformed) {
        expect(result.error).toBeInstanceOf(Error);
        expect(await closed).toBe(-1);
      } else {
        expect(result).toEqual({ code: 0, stdout: 'ready:independent' });
        expect(await execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('next')"]))
          .toEqual({ stdout: 'next', stderr: '' });
      }
    } finally {
      if (!child.closed) child.kill();
      await closed;
    }
  });

  it('keeps streams and commands independent under output backpressure', async () => {
    const managedSpawn = getProcessBrokerSpawn();
    expect(managedSpawn).toBeTypeOf('function');
    const noisy = "const chunk=Buffer.alloc(65536,97);const write=()=>{while(process.stdout.write(chunk));process.stdout.once('drain',write)};write()";
    const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(noisy)}],{stdio:['ignore',1,'ignore']});setTimeout(()=>process.stderr.write('ready'),50);setInterval(()=>{},60000)`;
    const child = managedSpawn(process.execPath, ['-e', script]);
    const failed = new Promise((_, reject) => child.once('error', reject));
    const closed = new Promise((resolve) => child.once('close', resolve));
    const marker = new Promise((resolve) => child.stderr.once('data', resolve));
    const withTimeout = (task, stage) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${stage}`)), 3_000);
      task.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
    try {
      await withTimeout(Promise.race([marker, failed]), 'independent stderr');
      const result = await withTimeout(Promise.race([
        execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('independent')"]),
        failed,
      ]), 'independent command');
      expect(result).toEqual({ stdout: 'independent', stderr: '' });
      const flowing = new Promise((resolve) => child.stdout.once('data', resolve));
      child.stdout.resume();
      await withTimeout(Promise.race([flowing, failed]), 'continuous output');
      const fair = await withTimeout(Promise.race([
        execFileWithProcessBroker(process.execPath, ['-e', "process.stdout.write('fair')"]),
        failed,
      ]), 'fair command');
      expect(fair).toEqual({ stdout: 'fair', stderr: '' });
    } finally {
      child.kill();
      await closed;
    }
  }, 10_000);

  it('rejects simple-git and closes the process when the broker disconnects', async () => {
    const managedSpawn = getProcessBrokerSpawn();
    expect(managedSpawn).toBeTypeOf('function');
    const events = [];
    let closeCode;
    let child;
    let resolveStarted;
    let rejectStarted;
    let resolveClosed;
    let rejectClosed;
    let timeout;
    const started = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    const spawn = (...args) => {
      child = managedSpawn(...args);
      child.once('spawn', () => {
        child.off('error', rejectStarted);
        resolveStarted();
      });
      child.once('error', rejectStarted);
      child.on('error', () => events.push('error'));
      child.on('close', (code) => {
        if (timeout) clearTimeout(timeout);
        closeCode = code;
        events.push('close');
        resolveClosed();
      });
      return child;
    };
    const pending = simpleGit({
      baseDir: process.cwd(),
      binary: resolveGitBinary(),
      spawn,
      unsafe: { allowUnsafeCustomBinary: true },
    }).raw(['cat-file', '--batch']);
    const outcome = pending.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await started;
    timeout = setTimeout(() => rejectClosed(new Error('Timed out waiting for broker disconnect')), 5_000);

    let result;
    try {
      const brokerPid = findBrokerPid();
      expect(brokerPid).toBeGreaterThan(0);
      process.kill(brokerPid, 'SIGKILL');
      await closed;
      result = await outcome;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child && !child.closed) child.kill();
      await closed.catch(() => {});
    }
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toContain('Windows process broker');
    expect(closeCode).toBe(-1);
    expect(child.exitCode).toBe(-1);
    expect(events).toEqual(['error', 'close']);
  });
});
