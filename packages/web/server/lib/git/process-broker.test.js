import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
