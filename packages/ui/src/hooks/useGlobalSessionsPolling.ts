import React from 'react';
import { getAllSyncSessions } from '@/sync/sync-refs';
import {
  ensureGlobalSessionsLoaded,
  refreshGlobalSessions,
} from '@/stores/useGlobalSessionsStore';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';

export const GLOBAL_SESSIONS_REFRESH_INTERVAL_MS = 45_000;

type ScheduleInterval = (callback: () => void, delay: number) => number;
type ClearInterval = (intervalId: number) => void;

export const startGlobalSessionsPolling = (
  initialLoad: () => void,
  refresh: () => void,
  scheduleInterval: ScheduleInterval = window.setInterval.bind(window),
  clearScheduledInterval: ClearInterval = window.clearInterval.bind(window),
): (() => void) => {
  initialLoad();
  const intervalId = scheduleInterval(refresh, GLOBAL_SESSIONS_REFRESH_INTERVAL_MS);
  return () => clearScheduledInterval(intervalId);
};

/**
 * Owns the one global-session polling lifecycle for the main app runtime.
 *
 * Each load is followed by host-guided recovery. The host's cross-project map
 * selects activity-bearing directories for authoritative reads without a full
 * bootstrap. Directory ownership comes from the global list just loaded.
 */
export const useGlobalSessionsPolling = (enabled: boolean): void => {
  React.useEffect(() => {
    if (!enabled) return;

    return startGlobalSessionsPolling(
      () => { void ensureGlobalSessionsLoaded(getAllSyncSessions()).finally(() => seedGlobalSessionStatusFromHost()); },
      () => { void refreshGlobalSessions().finally(() => seedGlobalSessionStatusFromHost()); },
    );
  }, [enabled]);
};
