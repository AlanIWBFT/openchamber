// Runtime configuration unlocks the renderer independently of OpenCode readiness.
export const createDesktopStartup = (publish) => {
  let snapshot = { phase: 'launching', revision: 0 };
  let documentState = 'loading';
  let resolveConfiguration;
  const configuration = new Promise((resolve) => { resolveConfiguration = resolve; });
  return {
    getState: () => ({ ...snapshot }),
    configure: () => resolveConfiguration(),
    waitForConfiguration: () => configuration,
    documentLoaded() {
      if (documentState === 'loading') documentState = 'loaded';
    },
    documentFailed() {
      if (documentState !== 'loading') return false;
      documentState = 'failed';
      return true;
    },
    update(phase) {
      if (snapshot.phase === 'failed' || snapshot.phase === phase) return;
      if (snapshot.phase === 'ready' && phase !== 'failed') return;
      snapshot = { phase, revision: snapshot.revision + 1 };
      publish(snapshot);
    },
  };
};

// This remains an in-memory startup queue, not an acknowledged/retrying transport.
export const createDesktopDeepLinkQueue = ({ isReady, dispatch, onError }) => {
  const pending = [];
  let flushing = false;
  const flush = async () => {
    if (flushing) return;
    flushing = true;
    try {
      while (pending.length > 0) {
        let skipped = 0;
        while (skipped < pending.length && pending[skipped].type === 'session' && !isReady(pending[skipped])) skipped += 1;
        if (skipped === pending.length || !isReady(pending[skipped])) break;
        const [link] = pending.splice(skipped, 1);
        try {
          // Only an actual host navigation supersedes the sessions it overtook.
          // While dispatch is in flight, enqueue only appends, leaving the skipped prefix intact.
          await dispatch(link, () => {
            pending.splice(0, skipped);
            skipped = 0;
          });
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      flushing = false;
    }
  };
  return {
    enqueue(link) {
      pending.push(link);
      void flush();
    },
    flush,
  };
};
