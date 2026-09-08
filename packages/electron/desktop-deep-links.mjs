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
