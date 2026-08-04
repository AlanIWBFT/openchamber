import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { createRelayService } from './service.js';

describe('relay service shutdown', () => {
  it('prevents an in-flight reconcile from starting the relay', async () => {
    let resolveDemand;
    const hasRelayDemand = vi.fn(() => new Promise((resolve) => {
      resolveDemand = resolve;
    }));
    const writeSettingsToDisk = vi.fn(async () => {});
    const service = createRelayService({
      crypto,
      readSettingsFromDiskMigrated: async () => ({
        privateRelay: { enabled: false, relayUrl: 'wss://relay.openchamber.dev/ws' },
      }),
      writeSettingsToDisk,
      readSettingsStrict: async () => ({}),
      getLocalPort: () => 3000,
      hasRelayDemand,
    });

    const reconcile = service.reconcile();
    await vi.waitFor(() => expect(resolveDemand).toBeTypeOf('function'));
    service.shutdown();
    resolveDemand(true);
    await reconcile;

    expect(writeSettingsToDisk).not.toHaveBeenCalled();
    expect(await service.getStatus()).toMatchObject({ state: 'disabled' });
  });
});
