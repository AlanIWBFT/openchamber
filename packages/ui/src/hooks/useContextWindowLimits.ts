import React from 'react';

import { isAutoModel } from '@/lib/routing/autoModel';
import {
  findAnsweringModelKey,
  limitsForAnsweringModel,
  type ContextWindowLimits,
} from '@/lib/routing/contextWindowLimits';
import { useConfigStore } from '@/stores/useConfigStore';
import { useDirectorySync } from '@/sync/sync-context';

/**
 * Which model's window the context readouts measure against.
 *
 * Normally the composer's model: the fill is shown against the window the next
 * message goes into. Under Auto the composer names no real model — the server
 * picks one per turn — so the limits come from the model that produced the
 * newest assistant message, the window the session actually ran in. Without
 * this, Auto reads as "no limit" and every readout divides by the 200k default,
 * which shows a 1M-window session as five times fuller than it is.
 */
export const useContextWindowLimits = (sessionId: string | null, directory?: string): ContextWindowLimits => {
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const getCurrentModel = useConfigStore((state) => state.getCurrentModel);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const auto = isAutoModel(currentProviderId, currentModelId);

  const answeringModelKey = useDirectorySync(
    React.useCallback((state) => (
      auto && sessionId ? findAnsweringModelKey(state.message[sessionId] ?? []) : null
    ), [auto, sessionId]),
    directory,
  );

  return React.useMemo(() => {
    if (auto) return limitsForAnsweringModel(answeringModelKey, getModelMetadata);
    const limit = getCurrentModel()?.limit;
    return { context: limit?.context ?? 0, output: limit?.output ?? 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the getters' output tracks the selected model ids
  }, [auto, answeringModelKey, currentProviderId, currentModelId, getCurrentModel, getModelMetadata]);
};
