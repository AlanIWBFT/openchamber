import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNetworkOperations, createTrustedDirectoriesConfig } from './network-operations.js';
import { getProcessBrokerSpawn } from './process-broker.js';
import { resolveGitBinary } from './git-binary.js';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';

const broker = process.env.OPENCHAMBER_PROCESS_BROKER_PATH?.trim();
const available = process.platform === 'win32' && broker && fs.statSync(broker, { throwIfNoEntry: false })?.isFile();

describe.runIf(available)('broker-backed Git network operations', () => {
  it('reads trusted directories through the broker and refreshes the private config', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-trust-broker-'));
    const globalConfig = path.join(directory, 'global');
    const children = [];
    const trusted = createTrustedDirectoriesConfig({
      gitBinary: resolveGitBinary(),
      inheritedEnv: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig },
      tmpdir: () => directory,
      spawnImpl: (...args) => {
        const child = getProcessBrokerSpawn()(...args);
        children.push(child);
        return child;
      },
    });
    try {
      fs.writeFileSync(globalConfig, '[safe]\n\tdirectory = C:/trusted\n');
      const config = await trusted();
      expect(fs.readFileSync(config, 'utf8')).toContain('directory = "C:/trusted"');
      fs.writeFileSync(globalConfig, '[safe]\n\tdirectory = C:/replacement\n');
      expect(await trusted()).toBe(config);
      const content = fs.readFileSync(config, 'utf8');
      expect(content).toContain('directory = "C:/replacement"');
      expect(content).not.toContain('C:/trusted');
      expect(children).toHaveLength(2);
      expect(children.every((child) => child.closed)).toBe(true);
    } finally {
      await Promise.all(children.filter((child) => !child.closed).map((child) => new Promise((resolve) => {
        child.once('close', resolve);
        child.kill();
      })));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'timeout', 'cancel'])('closes its process tree on %s', async (mode) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-network-broker-'));
    const endpoint = 'https://example.invalid/project.git';
    const fingerprint = fingerprintRemoteUrl(endpoint);
    const children = [];
    const service = createNetworkOperations({
      runtimeIdentity: { id: 'broker_test', platform: 'web' },
      platform: 'win32',
      timeoutMs: mode === 'timeout' ? 500 : 5000,
      validateGitTransportContext: async () => ({ endpoint, endpointFingerprint: fingerprint, transportMode: 'system', transportRevision: 'one' }),
      credentialResolver: { resolve: async () => ({ mode: 'system' }) },
      resolveRef: async () => 'a'.repeat(40),
      enumerateManagedConfigKeys: async () => [],
      inheritedEnv: process.env,
      spawnImpl: (file, args, options) => {
        // Exercise the real broker and operation ownership, without a remote transfer.
        expect(file).not.toBe('taskkill');
        const script = mode === 'complete'
          ? "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('finished'))"
          : "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore',windowsHide:true});process.stdout.write('ready');setInterval(()=>{},60000)";
        const child = getProcessBrokerSpawn()(process.execPath, ['-e', script], options);
        children.push(child);
        return child;
      },
    });
    try {
      const plan = await service.plan({
        operation: 'fetch', directory, repositoryId: 'repo_one', bindingRevision: 1, configRevision: 'one',
        remote: { name: 'origin', endpoint: { displayUrl: endpoint, fingerprint } },
        sourceRef: 'refs/heads/main', destinationRef: 'refs/remotes/origin/main', transportMode: 'system',
      });
      const pending = service.execute(plan.operationId);
      if (mode === 'cancel') {
        await expect.poll(() => children.length).toBeGreaterThan(0);
        await service.cancel(plan.operationId);
      }
      const result = await pending;
      expect(result.state).toBe(mode === 'complete' ? 'succeeded' : 'cancelled');
      expect(children.length).toBeGreaterThan(0);
      expect(children.every((child) => child.closed)).toBe(true);
      fs.rmdirSync(directory);
    } finally {
      await Promise.all(children.filter((child) => !child.closed).map((child) => new Promise((resolve) => {
        child.once('close', resolve);
        child.kill();
      })));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
