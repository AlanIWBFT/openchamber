import { afterEach, describe, expect, test } from 'bun:test';

import { isAgentMemoryFeatureAvailable } from './feature-flag.js';

const original = process.env.OPENCHAMBER_MEMORY_ENABLE;

afterEach(() => {
  if (original === undefined) delete process.env.OPENCHAMBER_MEMORY_ENABLE;
  else process.env.OPENCHAMBER_MEMORY_ENABLE = original;
});

describe('the memory availability gate', () => {
  test('is open when the variable is unset', () => {
    delete process.env.OPENCHAMBER_MEMORY_ENABLE;
    expect(isAgentMemoryFeatureAvailable()).toBe(true);
  });

  test('opens for the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      process.env.OPENCHAMBER_MEMORY_ENABLE = value;
      expect(isAgentMemoryFeatureAvailable()).toBe(true);
    }
  });

  test('stays closed for anything else, including "false"', () => {
    for (const value of ['', '0', 'false', 'no', 'off', 'maybe']) {
      process.env.OPENCHAMBER_MEMORY_ENABLE = value;
      expect(isAgentMemoryFeatureAvailable()).toBe(false);
    }
  });

  test('is read per call, so the process environment is authoritative', () => {
    delete process.env.OPENCHAMBER_MEMORY_ENABLE;
    expect(isAgentMemoryFeatureAvailable()).toBe(true);
    process.env.OPENCHAMBER_MEMORY_ENABLE = 'off';
    expect(isAgentMemoryFeatureAvailable()).toBe(false);
    process.env.OPENCHAMBER_MEMORY_ENABLE = '1';
    expect(isAgentMemoryFeatureAvailable()).toBe(true);
  });
});
