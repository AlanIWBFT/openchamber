import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

import { createSettingsAccessors } from './cli-settings-accessors.js';
import { createRelayIdentityRuntime } from '../../server/lib/relay/identity.js';

const withTempDir = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-settings-accessors-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const makeAccessors = (dir) =>
  createSettingsAccessors({ fsPromises: fs.promises, path, dataDir: dir, settingsFileName: 'settings.json' });

describe('cli settings accessors', () => {
  it('persists the full object atomically and cleans up its tmp file', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      await accessors.writeSettingsToDisk({ theme: 'dark', count: 3 });

      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
      expect(raw).toEqual({ theme: 'dark', count: 3 });

      const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith('settings.json.tmp-'));
      expect(leftovers).toEqual([]);
    });
  });

  it('never leaves a partial file observable by a concurrent reader during writes', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      const filePath = path.join(dir, 'settings.json');

      // Hammer reads concurrently with writes; every observed payload must be a
      // complete, parseable object (the old plain writeFile could surface a
      // torn file mid-rename, which is what tripped the relay identity logic).
      const stop = { value: false };
      const reader = (async () => {
        while (!stop.value) {
          try {
            const parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
            if (parsed && typeof parsed === 'object') {
              // A complete object is always fine; anything else would be a tear.
              expect(parsed.theme).toBe('dark');
            }
          } catch {
            // ENOENT during the very first write is acceptable.
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })();

      const big = { theme: 'dark', filler: 'x'.repeat(4096) };
      await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          accessors.writeSettingsToDisk({ ...big, n: i }).catch(() => {}),
        ),
      );
      stop.value = true;
      await reader;

      const final = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      expect(final.theme).toBe('dark');
    });
  });

  it('lenient read maps a corrupt file to {} for config lookup', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"unfinished": "trunc');
      expect(await accessors.readSettingsFromDiskMigrated()).toEqual({});
    });
  });

  it('strict read throws on a corrupt file instead of reporting "no settings"', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"unfinished": "trunc');
      await expect(accessors.readSettingsStrict()).rejects.toThrow();
    });
  });

  it('strict read throws on a non-object payload', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(path.join(dir, 'settings.json'), '"just a string"');
      await expect(accessors.readSettingsStrict()).rejects.toThrow(/non-object payload/);
    });
  });

  it('strict read treats only a genuinely missing file as no settings', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      expect(await accessors.readSettingsStrict()).toEqual({});
    });
  });

  it('does not regenerate the relay identity off a corrupt settings file', async () => {
    await withTempDir(async (dir) => {
      const accessors = makeAccessors(dir);
      fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify({
          relaySigningKey: {
            privateJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' }),
            publicJwk: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }),
          },
        }),
      );
      const identity = await createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity();
      const serverIdBefore = identity.serverId;

      // Corrupt the file, then ask for the identity again: the strict gate must
      // make this FAIL rather than mint a replacement keypair.
      fs.writeFileSync(path.join(dir, 'settings.json'), '{"relaySigningKey": {"unfinished');
      await expect(createRelayIdentityRuntime({ crypto, ...accessors }).getRelayIdentity()).rejects.toThrow();
      expect(serverIdBefore).toBeTruthy();
    });
  });
});
