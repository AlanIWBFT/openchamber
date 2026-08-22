import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import simpleGit from 'simple-git';
import { expect, it, vi } from 'vitest';

it('allows the process launcher to be injected', async () => {
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    queueMicrotask(() => {
      child.stdout.end('git version injected\n');
      child.stderr.end();
      child.emit('exit', 0, null);
      child.emit('close', 0, null);
    });
    return child;
  });
  const git = simpleGit({ baseDir: process.cwd(), spawn });

  await expect(git.raw(['--version'])).resolves.toBe('git version injected\n');
  expect(spawn).toHaveBeenCalledOnce();
});

it('waits for close when a managed process fails after exit', async () => {
  const spawn = vi.fn(() => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => true;
    setTimeout(() => child.emit('exit', 0, null), 0);
    setTimeout(() => {
      child.emit('error', new Error('broker disconnected'));
      child.stdout.destroy();
      child.stderr.destroy();
      child.emit('close', -1, null);
    }, 250);
    return child;
  });
  const git = simpleGit({
    baseDir: process.cwd(),
    completion: { onClose: true, onExit: false },
    spawn,
  });

  await expect(git.raw(['--version'])).rejects.toThrow('broker disconnected');
  expect(spawn).toHaveBeenCalledOnce();
});
