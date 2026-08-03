/**
 * Sanitize environment objects inherited by user-facing child processes.
 *
 * Linux AppImage runtimes export `ARGV0` as the AppImage path before launching
 * the packaged app. zsh treats an exported `ARGV0` as the argv[0] for every
 * external command it spawns, which corrupts Python venv detection and any
 * other program that reads argv[0]/$0 while leaving `/proc/self/exe` correct.
 *
 * See openchamber/openchamber#2588 and pingdotgg/t3code#2509.
 */

/**
 * Remove AppImage `ARGV0` from a mutable env object (or `process.env`).
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @returns {typeof env}
 */
export function stripAppImageArgv0Leak(env) {
  if (!env || typeof env !== 'object') return env;
  if (Object.prototype.hasOwnProperty.call(env, 'ARGV0')) {
    delete env.ARGV0;
  }
  return env;
}
