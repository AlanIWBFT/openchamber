// release all of them before Electron exits. Only that owner terminates OpenCode.
export async function stopEmbeddedServer(handle, { warn, timeoutMs = 35_000 }) {
  if (!handle) return;
  let timer;
  try {
    await Promise.race([
      handle.stop({ exitProcess: false, deadline: Date.now() + timeoutMs }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Embedded server shutdown timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    warn(error);
  } finally {
    clearTimeout(timer);
  }
}
