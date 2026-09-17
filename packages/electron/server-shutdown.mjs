// The backend owns child termination and its deadline. Electron waits for that
// owner instead of launching a second killer against the same process.
export async function stopEmbeddedServer(handle, { deadline, warn }) {
  if (!handle) return;
  try {
    await handle.stop({ exitProcess: false, deadline });
  } catch (error) {
    warn(error);
  }
}
