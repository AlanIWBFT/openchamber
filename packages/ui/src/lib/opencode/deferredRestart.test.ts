import { describe, expect, mock, test } from 'bun:test';

describe('deferred OpenCode restart helpers', () => {
  test('isDeferredRestartPayload detects deferred responses', async () => {
    const { isDeferredRestartPayload } = await import('./deferredRestart');

    expect(isDeferredRestartPayload({
      requiresReload: false,
      requiresRestart: true,
      restartDeferred: true,
    })).toBe(true);

    expect(isDeferredRestartPayload({
      requiresReload: false,
      requiresRestart: true,
    })).toBe(true);

    expect(isDeferredRestartPayload({
      requiresReload: true,
      message: 'reloading',
    })).toBe(false);

    expect(isDeferredRestartPayload({
      requiresManualRestart: true,
      requiresRestart: true,
      restartDeferred: true,
    })).toBe(false);
  });

  test('noteDeferredRestartFromPayload records pending changes', async () => {
    const { usePendingOpenCodeRestartStore } = await import('@/stores/usePendingOpenCodeRestartStore');
    usePendingOpenCodeRestartStore.getState().clear();

    const { noteDeferredRestartFromPayload } = await import('./deferredRestart');
    const noted = noteDeferredRestartFromPayload({
      requiresReload: false,
      requiresRestart: true,
      restartDeferred: true,
    }, 'mcp', { id: 'filesystem' });

    expect(noted).toBe(true);
    expect(usePendingOpenCodeRestartStore.getState().changes).toHaveLength(1);
    expect(usePendingOpenCodeRestartStore.getState().changes[0]?.scope).toBe('mcp');
  });

  test('applyPendingOpenCodeRestart clears pending changes after success', async () => {
    mock.module('@/stores/useAgentsStore', () => ({
      reloadOpenCodeConfiguration: async () => undefined,
    }));

    const { usePendingOpenCodeRestartStore } = await import('@/stores/usePendingOpenCodeRestartStore');
    usePendingOpenCodeRestartStore.getState().clear();
    usePendingOpenCodeRestartStore.getState().recordChange({ scope: 'agents', id: 'demo' });

    const { applyPendingOpenCodeRestart } = await import('./deferredRestart');
    const result = await applyPendingOpenCodeRestart({ message: 'Applying…' });

    expect(result).toEqual({ ok: true });
    expect(usePendingOpenCodeRestartStore.getState().changes).toHaveLength(0);
    expect(usePendingOpenCodeRestartStore.getState().isApplying).toBe(false);
  });
});
