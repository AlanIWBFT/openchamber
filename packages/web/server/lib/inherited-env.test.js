import { describe, expect, it } from 'vitest';
import { stripAppImageArgv0Leak } from './inherited-env.js';

describe('stripAppImageArgv0Leak', () => {
  it('removes ARGV0 from a child env object', () => {
    const env = {
      PATH: '/usr/bin',
      ARGV0: '/path/to/OpenChamber-1.17.2-linux-x86_64.AppImage',
      SHELL: '/bin/zsh',
    };

    expect(stripAppImageArgv0Leak(env)).toBe(env);
    expect(env).toEqual({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    });
  });

  it('is a no-op when ARGV0 is absent', () => {
    const env = { PATH: '/usr/bin', SHELL: '/bin/bash' };
    stripAppImageArgv0Leak(env);
    expect(env).toEqual({ PATH: '/usr/bin', SHELL: '/bin/bash' });
  });

  it('tolerates nullish env values', () => {
    expect(stripAppImageArgv0Leak(null)).toBeNull();
    expect(stripAppImageArgv0Leak(undefined)).toBeUndefined();
  });
});
