const SHUTDOWN_FINALIZATION_RESERVE_MS = 500;

export const createShutdownFence = (getIsShuttingDown) => (_req, res, next) => {
  if (!getIsShuttingDown()) {
    next();
    return;
  }
  res.setHeader('Connection', 'close');
  res.status(503).json({ error: 'OpenChamber is shutting down' });
};

export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionWorkRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    messageQueueRuntime,
    dispatchResultsRuntime,
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
    getGuestSurfaceRuntime,
    getRealtimeProxyRuntime,
    getDictationRuntime,
    getRelayService,
    getRelayReconcileTimer,
    getSpacesHost = () => null,
  } = dependencies;

  let shutdownPromise = null;
  const serverConnections = new Set();
  let closingHttpServer = false;

  // Track TCP sockets before listen(): HTTP stops tracking them on upgrade,
  // even when no WebSocket handler completes the handshake.
  const trackServerConnections = (server) => {
    const onConnection = (socket) => {
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

  const runShutdown = async (options = {}) => {
    setIsShuttingDown(true);
    closingHttpServer = true;
    beginGuestServiceShutdown();
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();
    const deadline = Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + shutdownTimeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());

    // Both embedded stop() and daemon exits use this sequence. Close admission
    // synchronously above, then stop viewers before draining their services.
    const cleanupOperations = [
      () => clearInterval(getRelayReconcileTimer()),
      () => getGuestSurfaceRuntime()?.stop(),
      () => getRealtimeProxyRuntime()?.stop(),
      // The isolated-spaces host, when the switch is on: its connections into spaces end here.
      () => getSpacesHost()?.close(),
      () => getRelayService()?.shutdown(),
      () => getDictationRuntime()?.stop(),
      () => openCodeWatcherRuntime.stop(),
      () => sessionRuntime.dispose(),
      () => sessionAssistRuntime?.stop?.(),
      () => sessionWorkRuntime?.stop?.(),
      () => sessionGoalRuntime?.stop?.(),
      () => contextObligatoryRuntime?.stop?.(),
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
    const results = await Promise.allSettled([
      ...cleanupPromises,
      Promise.resolve().then(() => terminalRuntime?.shutdown()),
      Promise.resolve().then(() => messageStreamRuntime?.close()),
      Promise.resolve().then(() => stopManagedOpenCode({ deadline: Math.max(Date.now(), deadline - SHUTDOWN_FINALIZATION_RESERVE_MS) })),
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
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
            // The backend has stopped. Active SSE/HTTP clients must not keep
            // Desktop waiting for the outer shutdown deadline.
            server.closeAllConnections?.();
            // Includes upgraded sockets and reconnects accepted while the
            // services above were draining. No child-process grace is cut short.
            for (const socket of serverConnections) socket.destroy();
          }),
          new Promise((resolve) => {
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

  const gracefulShutdown = (options = {}) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = runShutdown(options);
    return shutdownPromise;
  };

  return {
    gracefulShutdown,
    trackServerConnections,
  };
};
