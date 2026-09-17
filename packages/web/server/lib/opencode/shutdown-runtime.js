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
    stopBackgroundResources,
    stopManagedOpenCode,
    stopGuestServices,
    getServer,
    getUiAuthController,
    setUiAuthController,
    tunnelAuthController,
  } = dependencies;
  let shutdownPromise = null;

  const runShutdown = async (options) => {
    setIsShuttingDown(true);
    syncToHmrState();
    const exitProcess = options.exitProcess ?? getExitOnShutdown();
    const deadline = Number.isFinite(options.deadline) ? options.deadline : Date.now() + shutdownTimeoutMs;
    console.log('Starting graceful shutdown...');

    // Fence requests and stop producers before asking either child owner to exit.
    try {
      stopBackgroundResources();
    } catch (error) {
      console.warn('Error stopping background resources:', error);
    }
    const results = await Promise.allSettled([
      Promise.resolve().then(() => stopManagedOpenCode({ deadline })),
      Promise.resolve().then(() => stopGuestServices({ shutdown: true })),
    ]);
    for (const result of results) {
      if (result.status === 'rejected') console.warn('Error stopping backend children:', result.reason);
    }

    const server = getServer();
    if (server) {
      let timer;
      try {
        await Promise.race([
          new Promise((resolve) => {
            server.close(resolve);
            server.closeAllConnections?.();
          }),
          new Promise((resolve) => {
            timer = setTimeout(() => {
              console.warn('Server close timeout reached, forcing shutdown');
              resolve();
            }, Math.max(0, deadline - Date.now()));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    getUiAuthController()?.dispose();
    setUiAuthController(null);
    tunnelAuthController.clearActiveTunnel();
    console.log('Graceful shutdown complete');
    if (exitProcess) process.exit(0);
  };

  const gracefulShutdown = (options = {}) => {
    shutdownPromise ??= runShutdown(options);
    return shutdownPromise;
  };
  return { gracefulShutdown };
};
