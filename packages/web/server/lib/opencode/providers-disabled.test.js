import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The user config path is fixed when shared.js loads, so the calls run in a
// child process pointed at a temporary OPENCODE_CONFIG_DIR; the real user
// config is never touched.
const run = (configDir, body) => {
  const script = `
    import { readDisabledProviders, setProviderDisabled } from ${JSON.stringify(path.join(import.meta.dir, 'providers.js'))};
    ${body}
  `;
  const result = Bun.spawnSync(['bun', '-e', script], {
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return JSON.parse(result.stdout.toString().trim().split('\n').pop());
};

describe('disabled providers', () => {
  let configDir;
  beforeEach(() => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-disabled-providers-'));
  });
  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  test('disables and re-enables a provider in the user config, keeping other keys', () => {
    fs.writeFileSync(path.join(configDir, 'opencode.json'), JSON.stringify({ model: 'a/b', disabled_providers: ['groq'] }));

    const afterDisable = run(configDir, `
      setProviderDisabled('openrouter', true, null);
      setProviderDisabled('openrouter', true, null);
      console.log(JSON.stringify(readDisabledProviders(null)));
    `);
    expect(afterDisable).toEqual(['groq', 'openrouter']);

    const afterEnable = run(configDir, `
      setProviderDisabled('groq', false, null);
      setProviderDisabled('openrouter', false, null);
      console.log(JSON.stringify(readDisabledProviders(null)));
    `);
    expect(afterEnable).toEqual([]);
    const written = JSON.parse(fs.readFileSync(path.join(configDir, 'opencode.json'), 'utf8'));
    expect(written.model).toBe('a/b');
    expect(written.disabled_providers).toBeUndefined();
  });

  test('refuses an invalid provider id', () => {
    expect(() => run(configDir, `setProviderDisabled('Bad Id', true, null); console.log('[]');`)).toThrow('Invalid provider ID');
  });
});
