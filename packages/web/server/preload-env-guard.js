import { AsyncLocalStorage } from 'node:async_hooks';

const GUARD_FILE_NAME = 'preload-env-guard.js';

const findExternalSourceFrame = (stack) => {
  for (const rawFrame of String(stack || '').split('\n').slice(1)) {
    const frame = rawFrame.trim();
    if (!frame || frame.includes(GUARD_FILE_NAME)) continue;
    if (frame.endsWith('(<anonymous>)')) continue;
    if (frame.includes('node:internal') || frame.includes('(node:')) return null;
    return frame;
  }
  return null;
};

const nextEventLoopTurn = () => new Promise((resolve) => setImmediate(resolve));

export const capturePreloadEnvironmentAccesses = async (
  load,
  {
    processLike = process,
    shouldCapture = () => true,
    settle = nextEventLoopTurn,
  } = {},
) => {
  if (!load) throw new TypeError('load is required');
  if (!processLike?.env) throw new TypeError('processLike.env is required');

  const storage = new AsyncLocalStorage();
  const auditContext = {};
  const originalEnv = processLike.env;
  const accesses = new Map();
  const enumeratedFrames = new Set();

  const record = (operation, property) => {
    if (storage.getStore() !== auditContext || !shouldCapture()) return;
    const frame = findExternalSourceFrame(new Error().stack);
    if (!frame) return;
    if (operation === 'describe' && enumeratedFrames.has(frame)) return;
    if (operation === 'enumerate') enumeratedFrames.add(frame);
    const key = String(property);
    const identity = `${operation}\0${key}\0${frame}`;
    if (!accesses.has(identity)) accesses.set(identity, { operation, key, frame });
  };

  const guardedEnv = new Proxy(originalEnv, {
    get(target, property) {
      record('read', property);
      return target[property];
    },
    has(target, property) {
      record('check', property);
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      record('enumerate', '*');
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, property) {
      record('describe', property);
      return Reflect.getOwnPropertyDescriptor(target, property);
    },
    set(target, property, value) {
      record('write', property);
      return Reflect.set(target, property, value);
    },
    defineProperty(target, property, descriptor) {
      record('define', property);
      return Reflect.defineProperty(target, property, descriptor);
    },
    deleteProperty(target, property) {
      record('delete', property);
      return Reflect.deleteProperty(target, property);
    },
  });

  processLike.env = guardedEnv;
  try {
    const value = await storage.run(auditContext, load);
    if (settle) await settle();
    return { value, accesses: [...accesses.values()] };
  } finally {
    if (processLike.env === guardedEnv) processLike.env = originalEnv;
    storage.disable();
  }
};
