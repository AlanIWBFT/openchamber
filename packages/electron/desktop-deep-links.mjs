// An in-memory navigation queue, not an acknowledged/retrying transport.
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
          // Discard the skipped sessions only when host navigation actually starts.
          // Enqueues during dispatch append after that stable prefix.
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

// Only host actions cross to the renderer and report whether a switch committed.
export const createDesktopHostActionQueue = () => {
  let nextId = 0;
  const pending = [];
  const claimed = new Map();
  return {
    enqueue(action) {
      return new Promise((resolve) => pending.push({ action: { ...action, id: ++nextId }, resolve }));
    },
    take(owner) {
      return pending.splice(0).map((entry) => {
        claimed.set(entry.action.id, { owner, resolve: entry.resolve });
        return entry.action;
      });
    },
    complete(owner, id, committed) {
      const entry = claimed.get(id);
      if (!entry || entry.owner !== owner) return false;
      claimed.delete(id);
      entry.resolve(committed === true);
      return true;
    },
    cancelOwner(owner) {
      for (const [id, entry] of claimed) {
        if (entry.owner !== owner) continue;
        claimed.delete(id);
        entry.resolve(false);
      }
    },
  };
};
