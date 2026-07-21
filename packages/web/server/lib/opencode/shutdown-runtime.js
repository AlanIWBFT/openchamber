const SHUTDOWN_FINALIZATION_RESERVE_MS = 500;

export const createGracefulShutdownRuntime = (dependencies) => {
  const {
    process,
    shutdownTimeoutMs,
    getExitOnShutdown,
    getIsShuttingDown,
    setIsShuttingDown,
    syncToHmrState,
    openCodeWatcherRuntime,
    sessionRuntime,
    sessionAssistRuntime,
    sessionGoalRuntime,
    contextObligatoryRuntime,
    scheduledTasksRuntime,
    getHealthCheckInterval,
    clearHealthCheckInterval,
    getTerminalRuntime,
    setTerminalRuntime,
    getMessageStreamRuntime,
    setMessageStreamRuntime,
    shouldSkipOpenCodeStop,
    getOpenCodePort,
    getOpenCodeProcess,
    setOpenCodeProcess,
    killProcessOnPort,
    waitForPortRelease,
    getServer,
    getUiAuthController,
    setUiAuthController,
    getActiveTunnelController,
    setActiveTunnelController,
    tunnelAuthController,
  } = dependencies;

  let shutdownPromise = null;

  const runShutdown = async (options = {}) => {
    if (getIsShuttingDown()) return;

    setIsShuttingDown(true);
    syncToHmrState();
    console.log('Starting graceful shutdown...');
    const exitProcess = typeof options.exitProcess === 'boolean' ? options.exitProcess : getExitOnShutdown();
    const deadline = typeof options.deadline === 'number' && Number.isFinite(options.deadline)
      ? options.deadline
      : Date.now() + shutdownTimeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());

    openCodeWatcherRuntime.stop();
    sessionRuntime.dispose();
    sessionAssistRuntime?.stop?.();
    sessionGoalRuntime?.stop?.();
    contextObligatoryRuntime?.stop?.();
    scheduledTasksRuntime?.stop?.();

    const healthCheckInterval = getHealthCheckInterval();
    if (healthCheckInterval) {
      clearHealthCheckInterval(healthCheckInterval);
    }

    const terminalRuntime = getTerminalRuntime();
    const messageStreamRuntime = getMessageStreamRuntime();
    const inputShutdown = Promise.allSettled([
      Promise.resolve().then(() => terminalRuntime?.shutdown()),
      Promise.resolve().then(() => messageStreamRuntime?.close()),
    ]).finally(() => {
      if (terminalRuntime) setTerminalRuntime(null);
      if (messageStreamRuntime) setMessageStreamRuntime(null);
    });
    const inputShutdownTimeout = Math.min(2000, remaining());
    if (inputShutdownTimeout > 0) {
      let timeout;
      try {
        await Promise.race([
          inputShutdown,
          new Promise((resolve) => {
            timeout = setTimeout(resolve, inputShutdownTimeout);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }

    if (!shouldSkipOpenCodeStop()) {
      const portToKill = getOpenCodePort();
      const openCodeProcess = getOpenCodeProcess();

      if (openCodeProcess) {
        console.log('Stopping OpenCode process...');
        try {
          await openCodeProcess.close({
            deadline: Math.max(Date.now(), deadline - SHUTDOWN_FINALIZATION_RESERVE_MS),
          });
        } catch (error) {
          console.warn('Error closing OpenCode process:', error);
        }
        setOpenCodeProcess(null);
      }

      killProcessOnPort(portToKill, remaining());
      if (!(await waitForPortRelease(portToKill, Math.min(5000, remaining())))) {
        console.warn(`Timed out waiting for OpenCode port ${portToKill} to be released during shutdown`);
      }
    } else {
      console.log('Skipping OpenCode shutdown (external server)');
    }

    const server = getServer();
    if (server) {
      let closeTimeout = null;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(() => {
              console.log('HTTP server closed');
              resolve();
            });
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
  };
};
