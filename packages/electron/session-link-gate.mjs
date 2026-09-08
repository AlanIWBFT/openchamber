// Tells whether the main window's current document listens for session links.
// A document that asks for its pending links (desktop_take_pending_session_links)
// has mounted its listener, and until then an event sent to it reaches nobody:
// the splash and an application document that finished loading look ready but
// are not. A remote page never asks, so only a remote document counts as
// listening once the fallback delay has passed without a request.
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
