import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createNetworkOperations } from './network-operations.js';
import { getProcessBrokerSpawn } from './process-broker.js';
import { fingerprintRemoteUrl } from '../source-control/url-redaction.js';

const broker = process.env.OPENCHAMBER_PROCESS_BROKER_PATH?.trim();
const available = process.platform === 'win32' && broker && fs.statSync(broker, { throwIfNoEntry: false })?.isFile();

describe.runIf(available)('broker-backed Git network operations', () => {
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
          : "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});process.stdout.write('ready');setInterval(()=>{},60000)";
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
