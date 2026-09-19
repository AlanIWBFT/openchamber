// Cleanup and the platform installer share one exit owner. A stopped backend
// cannot be rolled back by clearing flags; failure recovers in a fresh process.
export const createUpdateInstaller = ({ state, autoUpdater, shutdown, showFailure, restart, log, shutdownTimeoutMs = 40_000, installGraceMs = 15_000 }) => {
  let installation;
  return () => {
    if (installation) return installation;
    state.updateInstallPending = true;
    state.quitInProgress = true;
    installation = new Promise((resolve, reject) => {
      let settled = false;
      let graceTimer;
      const stopped = new Promise((ready) => setImmediate(ready)).then(async () => {
        let timer;
        try {
          await Promise.race([
            shutdown(),
            new Promise((done) => {
              timer = setTimeout(() => {
                log.warn('[electron] background shutdown timed out before update install; continuing');
                done();
              }, shutdownTimeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(graceTimer);
        autoUpdater.off('error', fail);
        state.updateInstallPending = false;
        state.installingUpdate = false;
        state.quitRequested = false;
        state.allowWindowClose = false;
        log.error('[electron] update install failed', error);
        reject(error instanceof Error ? error : new Error(String(error)));
        void stopped.catch(() => {}).then(showFailure)
          .catch((failure) => log.warn('[electron] failed to show update error', failure))
          .then(() => {
            state.allowWindowClose = true;
            restart();
          });
      };
      autoUpdater.on('error', fail);
      void stopped.then(() => {
        if (settled) return;
        graceTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          autoUpdater.off('error', fail);
          resolve(null);
        }, installGraceMs);
        state.quitRequested = true;
        state.installingUpdate = true;
        state.quitConfirmationPending = false;
        state.allowWindowClose = true;
        log.info('[electron] handing control to the platform installer');
        autoUpdater.quitAndInstall();
        state.updateInstallPending = false;
      }).catch(fail);
    });
    return installation;
  };
};
