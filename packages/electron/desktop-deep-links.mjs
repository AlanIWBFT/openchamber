// Readiness belongs to one loaded document. Only remote pages get the legacy
// best-effort fallback; local pages always wait for their React receiver.
export const createDesktopNavigationReadiness = ({ onReady, schedule = setTimeout, cancel = clearTimeout }) => {
  let frame = null;
  let ready = false;
  let timer = null;
  const clear = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  return {
    reset() {
      clear();
      frame = null;
      ready = false;
    },
    report(currentFrame, value) {
      clear();
      frame = currentFrame;
      ready = value;
      if (ready) onReady();
    },
    loaded(currentFrame, remote) {
      clear();
      if (frame !== currentFrame) ready = false;
      frame = currentFrame;
      if (!remote || ready) return;
      timer = schedule(() => {
        timer = null;
        ready = true;
        onReady();
      }, 10_000);
      timer?.unref?.();
    },
    isReady(currentFrame) {
      return ready && frame === currentFrame;
    },
  };
};

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
