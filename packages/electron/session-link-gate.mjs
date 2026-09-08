export const createSessionLinkGate = ({ fallbackMs, onFallback }) => {
  let listening = false;
  let frame;
  let fallbackTimer = null;

  const cancelFallback = () => {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  };

  return {
    isListening: (currentFrame) => listening && frame === currentFrame,
    documentAsked(currentFrame) {
      cancelFallback();
      frame = currentFrame;
      listening = true;
    },
    documentStopped(currentFrame) {
      if (frame !== currentFrame) return;
      cancelFallback();
      listening = false;
    },
    documentReplaced() {
      cancelFallback();
      frame = undefined;
      listening = false;
    },
    applicationDocumentLoaded(currentFrame, remote = true) {
      if (frame !== currentFrame) {
        cancelFallback();
        listening = false;
        frame = currentFrame;
      }
      if (!remote) return;
      if (listening || fallbackTimer) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        listening = true;
        onFallback();
      }, fallbackMs);
      fallbackTimer.unref?.();
    },
  };
};
