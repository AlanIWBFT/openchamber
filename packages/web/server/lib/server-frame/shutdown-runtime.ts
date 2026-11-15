import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { isBoolean } from '../shared/object-guards.js';

type Cleanup = () => void | Promise<void | object>;
type Stop = { stop: Cleanup };
type OptionalStop = Partial<Stop> | null;
type Close = { close: Cleanup };
type Timer = ReturnType<typeof setInterval>;

const SHUTDOWN_FINALIZATION_RESERVE_MS = 500;

export interface ShutdownOptions {
  deadline?: number;
  exitProcess?: boolean;
}

interface ShutdownDependencies {
  process: Pick<NodeJS.Process, 'exit'>;
  shutdownTimeoutMs: number;
  getExitOnShutdown: () => boolean;
  setIsShuttingDown: (value: boolean) => void;
  syncToHmrState: Cleanup;
  openCodeWatcherRuntime: Stop;
  chatDirectoryCleanupRuntime?: Stop | null;
  sessionRuntime: { dispose: Cleanup };
  sessionAssistRuntime?: OptionalStop;
  sessionWorkRuntime?: OptionalStop;
  sessionGoalRuntime?: OptionalStop;
  contextObligatoryRuntime?: OptionalStop;
  sessionWarmingRuntime?: OptionalStop;
  sessionTodosRuntime?: OptionalStop;
  memoryDreaming?: { stop: (options: { deadline: number }) => Promise<void> | void };
  autoReviewRuntime?: (Partial<Stop> & { flush?: () => Promise<void> }) | null;
  prWatchRuntime?: OptionalStop;
  extensionWaitsRuntime?: (Partial<Stop> & { flush?: Cleanup }) | null;
  laterPagesRuntime?: (Partial<Stop> & { flush?: Cleanup }) | null;
  sharePagesRuntime?: (Partial<Stop> & { flush?: Cleanup }) | null;
  notificationTriggerRuntime?: { stopShareAnswers?: Cleanup } | null;
  stopBackgroundReportSubscription?: Cleanup;
  mergeFollowRuntime?: OptionalStop;
  messageQueueRuntime?: OptionalStop;
  dispatchResultsRuntime?: OptionalStop;
  workflowRuntime?: { shutdown: Cleanup } | null;
  messageSearchRuntime?: OptionalStop;
  scheduledTasksRuntime?: OptionalStop;
  getHealthCheckInterval: () => Timer | null;
  clearHealthCheckInterval: (value: Timer) => void;
  getTerminalRuntime: () => { shutdown: Cleanup } | null;
  setTerminalRuntime: (value: null) => void;
  getMessageStreamRuntime: () => Close | null;
  setMessageStreamRuntime: (value: null) => void;
  stopManagedOpenCode: (options: Pick<ShutdownOptions, 'deadline'>) => Promise<unknown>;
  stopPermissionAutoAccept?: Cleanup;
  permissionAutoAcceptRuntime?: { shutdown: Cleanup };
  globalMessageStreamHub?: Stop;
  forceStopCloudflareTunnels?: Cleanup;
  forceStopNgrokTunnels?: Cleanup;
  getServer: () => Server | null;
  getUiAuthController: () => { dispose: Cleanup } | null;
  setUiAuthController: (value: null) => void;
  getActiveTunnelController: () => Stop | null;
  setActiveTunnelController: (value: null) => void;
  tunnelAuthController: { clearActiveTunnel: Cleanup };
  beginGuestServiceShutdown: Cleanup;
  stopAllGuestServices: Cleanup;
  extensionServiceLifetime?: OptionalStop;
  extensionSessionEvents?: OptionalStop;
  getGuestSurfaceRuntime: () => Stop | null;
  getRealtimeProxyRuntime: () => Stop | null;
  getDictationRuntime: () => Stop | null;
  getRelayService: () => { shutdown: Cleanup } | null;
  getRelayReconcileTimer: () => Timer | null;
  getSpacesHost?: () => Close | null;
  stopFolderWatches?: Cleanup;
}

export const createShutdownFence = (getIsShuttingDown: () => boolean): import('../shared/http-contracts.js').RequestHandler => (_req, res, next) => {
  if (!getIsShuttingDown()) {
    next();
    return;
  }
  res.setHeader('Connection', 'close');
  res.status(503).json({ error: 'OpenChamber is shutting down' });
};

export const createGracefulShutdownRuntime = (dependencies: ShutdownDependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    chatDirectoryCleanupRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionWorkRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    sessionWarmingRuntime,
    sessionTodosRuntime,
    memoryDreaming,
    autoReviewRuntime,
    prWatchRuntime,
    extensionWaitsRuntime = null,
    laterPagesRuntime = null,
    sharePagesRuntime = null,
    notificationTriggerRuntime = null,
    stopBackgroundReportSubscription = () => {},
    mergeFollowRuntime,
    messageQueueRuntime,
    dispatchResultsRuntime,
    workflowRuntime = null,
    messageSearchRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    stopManagedOpenCode,
    stopPermissionAutoAccept,
    permissionAutoAcceptRuntime,
    globalMessageStreamHub,
    forceStopCloudflareTunnels,
    forceStopNgrokTunnels,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
    beginGuestServiceShutdown,
    stopAllGuestServices,
    extensionServiceLifetime,
    extensionSessionEvents,
    getGuestSurfaceRuntime,
    getRealtimeProxyRuntime,
    getDictationRuntime,
    getRelayService,
    getRelayReconcileTimer,
    getSpacesHost = () => null,
    stopFolderWatches = () => {},
  } = dependencies;

  let shutdownPromise: Promise<void> | null = null;
  const serverConnections = new Set<Socket>();
  let closingHttpServer = false;

  const trackServerConnections = (server: Server) => {
    const onConnection = (socket: Socket) => {
      if (closingHttpServer) {
        socket.destroy();
        return;
      }
      serverConnections.add(socket);
      socket.once('close', () => serverConnections.delete(socket));
    };
    server.on('connection', onConnection);
    server.once('close', () => server.off('connection', onConnection));
  };

  const runShutdown = async (options: ShutdownOptions = {}) => {
    setIsShuttingDown(true);
    closingHttpServer = true;
    beginGuestServiceShutdown();
    extensionSessionEvents?.stop?.();
    extensionServiceLifetime?.stop?.();
    extensionWaitsRuntime?.stop?.();
    laterPagesRuntime?.stop?.();
    sharePagesRuntime?.stop?.();
    notificationTriggerRuntime?.stopShareAnswers?.();
    stopBackgroundReportSubscription();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = isBoolean(options.exitProcess) ? options.exitProcess : getExitOnShutdown();
    const deadline = typeof options.deadline === 'number' && Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + shutdownTimeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    const drain = async (name: string, operation: () => unknown) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error(`${name} shutdown timed out`)), Math.max(0, remaining() - SHUTDOWN_FINALIZATION_RESERVE_MS));
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    };

    let dreamCleanup: void | Promise<void>;
    const cleanupOperations = [
      () => clearInterval(getRelayReconcileTimer() ?? undefined),
      () => getGuestSurfaceRuntime()?.stop(),
      () => getRealtimeProxyRuntime()?.stop(),
      () => getSpacesHost()?.close(),
      () => getRelayService()?.shutdown(),
      () => getDictationRuntime()?.stop(),
      stopFolderWatches,
      () => chatDirectoryCleanupRuntime?.stop(),
      () => openCodeWatcherRuntime.stop(),
      () => sessionRuntime.dispose(),
      () => sessionAssistRuntime?.stop?.(),
      () => sessionWorkRuntime?.stop?.(),
      () => sessionGoalRuntime?.stop?.(),
      () => contextObligatoryRuntime?.stop?.(),
      () => sessionWarmingRuntime?.stop?.(),
      () => drain('Session todos', () => sessionTodosRuntime?.stop?.()),
      () => drain('Memory dreaming', () => (dreamCleanup = memoryDreaming?.stop({ deadline: Math.max(Date.now(), deadline - SHUTDOWN_FINALIZATION_RESERVE_MS) }))),
      () => drain('Extension waits', () => extensionWaitsRuntime?.flush?.()),
      () => drain('Later pages', () => laterPagesRuntime?.flush?.()),
      () => drain('Shared pages', () => sharePagesRuntime?.flush?.()),
      async () => {
        autoReviewRuntime?.stop?.();
        if (!autoReviewRuntime?.flush) return;
        // Stop only disarms the loop. Join in-flight Stop work and its writes so
        // restart cannot mistake an unpersisted stopping run for a running one.
        // Share the host budget: a stuck send must not hold daemon exit forever.
        await drain('Auto-review', () => autoReviewRuntime.flush?.());
      },
      () => prWatchRuntime?.stop?.(),
      () => mergeFollowRuntime?.stop?.(),
      () => messageQueueRuntime?.stop?.(),
      () => dispatchResultsRuntime?.stop?.(),
      () => messageSearchRuntime?.stop?.(),
      () => scheduledTasksRuntime?.stop?.(),
      () => stopPermissionAutoAccept?.(),
      () => permissionAutoAcceptRuntime?.shutdown(),
      () => globalMessageStreamHub?.stop(),
      () => forceStopCloudflareTunnels?.(),
      () => forceStopNgrokTunnels?.(),
      stopAllGuestServices,
    ];
    // Close each runtime's admission before yielding; asynchronous drains must
    // not delay starting the managed CLI's own deadline-bound cleanup.
    const cleanupPromises = cleanupOperations.map((cleanup) => {
      try {
        return Promise.resolve(cleanup());
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    const messageStreamRuntime = getMessageStreamRuntime();
    const closeBackend = async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const workflowDrain = workflowRuntime?.shutdown();
        if (workflowDrain || dreamCleanup) {
          await Promise.race([
            Promise.allSettled([workflowDrain, dreamCleanup]),
            new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, Math.min(2000, remaining() - SHUTDOWN_FINALIZATION_RESERVE_MS))); }),
          ]);
        }
      } catch (error) {
        console.warn('Workflow shutdown failed:', error);
      } finally { clearTimeout(timer); }
      await stopManagedOpenCode({ deadline: Math.max(Date.now(), deadline - SHUTDOWN_FINALIZATION_RESERVE_MS) });
    };
    const results = await Promise.allSettled([
      ...cleanupPromises,
      Promise.resolve().then(() => terminalRuntime?.shutdown()),
      Promise.resolve().then(() => messageStreamRuntime?.close()),
      Promise.resolve().then(closeBackend),
    ]).finally(() => {
      if (terminalRuntime) setTerminalRuntime(null);
      if (messageStreamRuntime) setMessageStreamRuntime(null);
    });

    for (const result of results) {
      if (result.status === 'rejected') console.warn('Error stopping backend resources:', result.reason);
    }

    const server = getServer();
    if (server) {
      closingHttpServer = true;
      let closeTimeout: ReturnType<typeof setTimeout> | null = null;
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            server.closeAllConnections?.();
            for (const socket of serverConnections) socket.destroy();
          }),
          new Promise<void>((resolve) => {
            closeTimeout = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, remaining());
          }),
        ]);
      } finally {
        if (closeTimeout) {
          clearTimeout(closeTimeout);
        }
      }
    }

    const uiAuthController = getUiAuthController();
    if (uiAuthController) {
      uiAuthController.dispose();
      setUiAuthController(null);
    }

    const activeTunnelController = getActiveTunnelController();
    if (activeTunnelController) {
      console.log('Stopping active tunnel...');
      activeTunnelController.stop();
      setActiveTunnelController(null);
      tunnelAuthController.clearActiveTunnel();
    }

    console.log('Graceful shutdown complete');
    if (exitProcess) {
      process.exit(0);
    }
  };

  const gracefulShutdown = (options: ShutdownOptions = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
