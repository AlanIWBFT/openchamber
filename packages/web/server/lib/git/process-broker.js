import { spawn as spawnChild } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { connect } from 'node:net';
import { PassThrough, Writable } from 'node:stream';
import { isMainThread, workerData } from 'node:worker_threads';

const MAGIC = 0x4250434f;
const VERSION = 2;
const HEADER_BYTES = 20;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const BROKER_FAILURE_EXIT_CODE = -1;
const OUTPUT_HIGH_WATER_MARK = 256 * 1024;
const OUTPUT_INITIAL_CREDIT = 64 * 1024;
const frameType = {
  hello: 1,
  helloOk: 2,
  spawn: 3,
  spawned: 4,
  stdin: 5,
  stdinClose: 6,
  stdout: 7,
  stderr: 8,
  exit: 9,
  close: 10,
  cancel: 11,
  error: 12,
  credit: 13,
  stdinAck: 14,
};

let mainPipe;
let mainExecutable;
let brokerProcess;
let brokerRestartTimer;
let brokerRestartDelay = 25;
let activeClient;
let managedSpawn;

export const getProcessBrokerWorkerData = () => {
  const pipe = getPipe();
  return pipe ? { processBrokerPipe: pipe } : undefined;
};

export const getProcessBrokerSpawn = () => {
  const pipe = getPipe();
  if (!pipe) return null;
  if (!managedSpawn) {
    managedSpawn = (command, args = [], options = {}) => {
      const child = new ManagedProcess();
      void getClient(pipe)
        .then((client) => client.spawn(child, command, args, options))
        .catch((error) => child.fail(error instanceof Error ? error : new Error(String(error))));
      return child;
    };
  }
  return managedSpawn;
};

export const execFileWithProcessBroker = (command, args, options = {}) => {
  const spawn = getProcessBrokerSpawn();
  if (!spawn) return null;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    const stdout = [];
    const stderr = [];
    const maxBuffer = options.maxBuffer ?? 1024 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let aborted = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => {
      aborted = options.signal?.reason instanceof Error
        ? options.signal.reason
        : Object.assign(new Error('The operation was aborted'), { code: 'ABORT_ERR' });
      child.kill();
    };
    const collect = (target, chunk, stream) => {
      const bytes = Buffer.from(chunk);
      if (stream === 'stdout') stdoutBytes += bytes.length;
      else stderrBytes += bytes.length;
      if (stdoutBytes > maxBuffer || stderrBytes > maxBuffer) {
        const error = Object.assign(new Error(`${stream} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        child.kill();
        finish(error);
        return;
      }
      target.push(bytes);
    };

    child.stdout.on('data', (chunk) => collect(stdout, chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(stderr, chunk, 'stderr'));
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (aborted) {
        finish(aborted);
        return;
      }
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      const encoding = options.encoding === 'buffer' ? null : (options.encoding || 'utf8');
      const result = {
        stdout: encoding ? stdoutBuffer.toString(encoding) : stdoutBuffer,
        stderr: encoding ? stderrBuffer.toString(encoding) : stderrBuffer,
      };
      if (code === 0) {
        finish(null, result);
        return;
      }
      finish(Object.assign(new Error(`Command failed with exit code ${code}`), { code, ...result }));
    });
    child.stdin.end();
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });
  });
};

class ManagedOutput extends PassThrough {
  constructor(type) {
    super({ highWaterMark: OUTPUT_HIGH_WATER_MARK });
    this.type = type;
    this.client = null;
    this.id = 0n;
    this.outstanding = 0;
    this.pendingCredit = 0;
    this.waitingForDrain = false;
    this.finished = false;
    this.discarded = false;
    this.once('close', () => {
      if (this.finished) return;
      this.discarded = true;
      this.flushCredit();
    });
  }

  attach(client, id) {
    this.client = client;
    this.id = id;
    this.grant(OUTPUT_INITIAL_CREDIT);
  }

  output(payload) {
    if (this.finished || payload.length > this.outstanding) return false;
    this.outstanding -= payload.length;
    if (this.destroyed) this.discarded = true;
    if (this.discarded || this.write(payload)) {
      this.grant(payload.length);
      return true;
    }
    this.pendingCredit += payload.length;
    if (!this.waitingForDrain) {
      this.waitingForDrain = true;
      this.once('drain', () => {
        this.waitingForDrain = false;
        this.flushCredit();
      });
    }
    return true;
  }

  complete() {
    if (this.finished) return;
    this.finished = true;
    if (!this.destroyed) this.end();
  }

  fail() {
    if (this.finished) return;
    this.finished = true;
    this.destroy();
  }

  grant(amount) {
    if (!this.client || this.finished || amount === 0) return;
    this.outstanding += amount;
    this.client.credit(this.id, this.type, amount);
  }

  flushCredit() {
    const amount = this.pendingCredit;
    this.pendingCredit = 0;
    this.grant(amount);
  }
}

class ManagedProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new ManagedOutput(frameType.stdout);
    this.stderr = new ManagedOutput(frameType.stderr);
    this.client = null;
    this.id = 0n;
    this.pid = undefined;
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this.closed = false;
    this.pendingWrite = null;
    this.pendingClose = null;
    this.stdinCallback = null;
    this.pendingKill = false;
    this.stdin = new Writable({
      write: (chunk, encoding, callback) => {
        const payload = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
        if (!this.client) {
          this.pendingWrite = { payload, callback };
          return;
        }
        this.startStdin(frameType.stdin, payload, callback);
      },
      final: (callback) => {
        if (!this.client) {
          this.pendingClose = callback;
          return;
        }
        this.startStdin(frameType.stdinClose, Buffer.alloc(0), callback);
      },
    });
    this.stdio = [this.stdin, this.stdout, this.stderr];
  }

  attach(client, id) {
    this.client = client;
    this.id = id;
    this.stdout.attach(client, id);
    this.stderr.attach(client, id);
    if (this.pendingWrite) {
      const pending = this.pendingWrite;
      this.pendingWrite = null;
      this.startStdin(frameType.stdin, pending.payload, pending.callback);
    }
    if (this.pendingClose) {
      const callback = this.pendingClose;
      this.pendingClose = null;
      this.startStdin(frameType.stdinClose, Buffer.alloc(0), callback);
    }
    if (this.pendingKill) client.write(frameType.cancel, id);
  }

  spawned(pid) {
    this.pid = pid;
    this.emit('spawn');
  }

  output(type, payload) {
    const stream = type === frameType.stdout ? this.stdout : type === frameType.stderr ? this.stderr : undefined;
    return stream?.output(payload) ?? false;
  }

  stdinAcknowledged(code) {
    this.finishStdin(code === 0 ? undefined : Object.assign(new Error(`Windows process broker stdin write failed (${code})`), { code }));
  }

  exited(code) {
    this.exitCode = code;
    this.emit('exit', code, null);
  }

  complete() {
    if (this.closed) return;
    this.closed = true;
    this.finishStdin(new Error('Windows process broker closed before stdin completed'));
    this.stdout.complete();
    this.stderr.complete();
    if (!this.stdin.destroyed) this.stdin.destroy();
    this.emit('close', this.exitCode, null);
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = BROKER_FAILURE_EXIT_CODE;
    this.pendingWrite?.callback(error);
    this.pendingClose?.(error);
    this.pendingWrite = null;
    this.pendingClose = null;
    this.finishStdin(error);
    this.stdout.fail();
    this.stderr.fail();
    this.stdin.destroy();
    this.emit('error', error);
    this.emit('close', this.exitCode, null);
  }

  kill() {
    if (this.closed) return false;
    this.killed = true;
    if (!this.client) {
      this.pendingKill = true;
      return true;
    }
    this.client.write(frameType.cancel, this.id);
    return true;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  startStdin(type, payload, callback) {
    if (!this.client) {
      callback(new Error('Windows process broker stdin is not attached'));
      return;
    }
    if (this.stdinCallback) {
      callback(new Error('Windows process broker received overlapping stdin writes'));
      return;
    }
    this.stdinCallback = callback;
    this.client.write(type, this.id, payload, (error) => {
      if (error) this.finishStdin(error);
    });
  }

  finishStdin(error) {
    const callback = this.stdinCallback;
    this.stdinCallback = null;
    callback?.(error);
  }
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.input = Buffer.alloc(0);
    this.nextId = 1n;
    this.commands = new Map();
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.helloResolve = resolve;
      this.helloReject = reject;
    });
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (error) => this.disconnect(error));
    socket.on('close', () => this.disconnect(new Error('Windows process broker disconnected')));
    this.write(frameType.hello, 0n);
  }

  spawn(process, executable, args, options) {
    const id = this.nextId;
    this.nextId += 1n;
    const env = options.env || globalThis.process.env;
    const environment = Object.entries(env).filter((entry) => entry[1] !== undefined);
    const parts = [u32(1), text(executable), text(options.cwd || globalThis.process.cwd()), u32(args.length)];
    for (const argument of args) parts.push(text(String(argument)));
    parts.push(u32(environment.length));
    for (const [key, value] of environment) parts.push(text(key), text(value));
    this.socket.ref();
    this.commands.set(id, process);
    this.write(frameType.spawn, id, Buffer.concat(parts), (error) => {
      if (!error) return;
      this.commands.delete(id);
      process.fail(error);
      if (this.commands.size === 0) this.socket.unref();
    });
    process.attach(this, id);
  }

  write(type, id, payload = Buffer.alloc(0), callback) {
    if (this.closed) {
      callback?.(new Error('Windows process broker is closed'));
      return;
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt16LE(VERSION, 4);
    header.writeUInt16LE(type, 6);
    header.writeBigUInt64LE(id, 8);
    header.writeUInt32LE(payload.length, 16);
    this.socket.write(payload.length === 0 ? header : Buffer.concat([header, payload]), callback);
  }

  credit(id, type, amount) {
    const payload = Buffer.allocUnsafe(6);
    payload.writeUInt16LE(type, 0);
    payload.writeUInt32LE(amount, 2);
    this.write(frameType.credit, id, payload);
  }

  onData(chunk) {
    this.input = this.input.length === 0 ? chunk : Buffer.concat([this.input, chunk]);
    while (this.input.length >= HEADER_BYTES) {
      if (this.input.readUInt32LE(0) !== MAGIC || this.input.readUInt16LE(4) !== VERSION) {
        this.socket.destroy(new Error('Invalid Windows process broker frame'));
        return;
      }
      const size = this.input.readUInt32LE(16);
      if (size > MAX_PAYLOAD_BYTES) {
        this.socket.destroy(new Error('Windows process broker frame is too large'));
        return;
      }
      if (this.input.length < HEADER_BYTES + size) return;
      const type = this.input.readUInt16LE(6);
      const id = this.input.readBigUInt64LE(8);
      const payload = this.input.subarray(HEADER_BYTES, HEADER_BYTES + size);
      this.input = this.input.subarray(HEADER_BYTES + size);
      this.dispatch(type, id, payload);
    }
  }

  dispatch(type, id, payload) {
    if (type === frameType.helloOk) {
      this.helloResolve?.();
      this.helloResolve = null;
      this.helloReject = null;
      return;
    }
    const process = this.commands.get(id);
    if (!process && type === frameType.stdinAck) return;
    if (!process) {
      this.socket.destroy(new Error(`Unknown Windows process broker command: ${id}`));
      return;
    }
    if (type === frameType.spawned && payload.length === 4) {
      process.spawned(payload.readUInt32LE(0));
      return;
    }
    if (type === frameType.stdinAck && payload.length === 4) {
      process.stdinAcknowledged(payload.readUInt32LE(0));
      return;
    }
    if (type === frameType.stdout || type === frameType.stderr) {
      if (!process.output(type, Buffer.from(payload))) this.socket.destroy(new Error('Windows process broker exceeded output credit'));
      return;
    }
    if (type === frameType.exit && payload.length === 4) {
      process.exited(payload.readUInt32LE(0));
      return;
    }
    if (type === frameType.close) {
      this.commands.delete(id);
      process.complete();
      if (this.commands.size === 0) this.socket.unref();
      return;
    }
    if (type === frameType.error) {
      this.commands.delete(id);
      process.fail(parseError(payload));
      if (this.commands.size === 0) this.socket.unref();
      return;
    }
    this.socket.destroy(new Error(`Unexpected Windows process broker frame: ${type}`));
  }

  disconnect(error) {
    if (this.closed) return;
    this.closed = true;
    this.helloReject?.(error);
    this.helloResolve = null;
    this.helloReject = null;
    for (const process of this.commands.values()) process.fail(error);
    this.commands.clear();
  }

}

const getPipe = () => {
  if (process.platform !== 'win32') return null;
  if (!isMainThread) return workerData?.processBrokerPipe || null;
  if (mainPipe) return mainPipe;
  const executable = process.env.OPENCHAMBER_PROCESS_BROKER_PATH?.trim();
  if (!executable || !fs.statSync(executable, { throwIfNoEntry: false })?.isFile()) return null;
  mainPipe = `\\\\.\\pipe\\openchamber-process-${process.pid}-${randomBytes(16).toString('hex')}`;
  mainExecutable = executable;
  startMainBroker();
  return mainPipe;
};

const startMainBroker = () => {
  if (!mainPipe || !mainExecutable || brokerProcess) return;
  const startedAt = Date.now();
  let child;
  try {
    child = spawnChild(mainExecutable, ['--pipe', mainPipe, '--parent-pid', String(process.pid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    scheduleBrokerRestart(0);
    return;
  }
  brokerProcess = child;
  let unavailable = false;
  const onUnavailable = () => {
    if (unavailable) return;
    unavailable = true;
    if (brokerProcess === child) brokerProcess = undefined;
    scheduleBrokerRestart(Date.now() - startedAt);
  };
  child.once('error', onUnavailable);
  child.once('exit', onUnavailable);
  child.unref();
};

const scheduleBrokerRestart = (uptime) => {
  if (brokerRestartTimer) return;
  if (uptime >= 5_000) brokerRestartDelay = 25;
  const delay = brokerRestartDelay;
  brokerRestartDelay = Math.min(brokerRestartDelay * 2, 1_000);
  brokerRestartTimer = setTimeout(() => {
    brokerRestartTimer = undefined;
    startMainBroker();
  }, delay);
  brokerRestartTimer.unref();
};

const getClient = (pipe) => {
  if (activeClient) {
    return activeClient.then((client) => {
      if (!client.closed) return client;
      activeClient = null;
      return getClient(pipe);
    });
  }
  activeClient = connectPipe(pipe, Date.now() + 5_000)
    .then(async (socket) => {
      const client = new Client(socket);
      await client.ready;
      socket.unref();
      return client;
    })
    .catch((error) => {
      activeClient = null;
      throw error;
    });
  return activeClient;
};

const connectPipe = (pipe, deadline) => new Promise((resolve, reject) => {
  const socket = connect(pipe);
  const onConnect = () => {
    socket.off('error', onError);
    resolve(socket);
  };
  const onError = (error) => {
    socket.off('connect', onConnect);
    socket.destroy();
    if (Date.now() >= deadline) {
      reject(error);
      return;
    }
    setTimeout(() => connectPipe(pipe, deadline).then(resolve, reject), 10);
  };
  socket.once('connect', onConnect);
  socket.once('error', onError);
});

const u32 = (value) => {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value);
  return output;
};

const text = (value) => {
  if (value.includes('\0')) throw new Error('Windows process arguments cannot contain NUL');
  const bytes = Buffer.from(value);
  return Buffer.concat([u32(bytes.length), bytes]);
};

const parseError = (payload) => {
  if (payload.length < 12) return new Error('Windows process broker failed');
  const code = payload.readUInt32LE(0);
  const stageSize = payload.readUInt32LE(4);
  if (8 + stageSize + 4 > payload.length) return new Error('Windows process broker failed');
  const stage = payload.toString('utf8', 8, 8 + stageSize);
  const messageSizeOffset = 8 + stageSize;
  const messageSize = payload.readUInt32LE(messageSizeOffset);
  const messageOffset = messageSizeOffset + 4;
  if (messageOffset + messageSize !== payload.length) return new Error('Windows process broker failed');
  return Object.assign(new Error(`${stage}: ${payload.toString('utf8', messageOffset)} (${code})`), { code, stage });
};
