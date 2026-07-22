/**
 * Archiving sessions, held by OpenCode since 2.1.
 *
 * Every archive and unarchive goes to OpenCode (`PATCH /api/session/{id}` with
 * `archived`), so the TUI and every other client share one archive. Since 2.2
 * that PATCH writes the record without building the session's location, so it
 * also works for a session whose directory is gone and starts no MCP servers.
 *
 * Deleted directories keep their original identity. The backend
 * owns timestamps and persistent-command cleanup; reads never overlay a file.
 * `archive-store.js` is only a migration source. Failed pushes retain entries
 * for the next startup; successful user writes retire their legacy entry too.
 *
 * One operation per session at a time: a migration push decided from an old
 * entry cannot land after the user's own archive or unarchive of that session.
 */

/** PATCHes in flight at once; one batch is a worktree's sessions or a sweep. */
const CONCURRENCY = 4;

const errorTag = (error) => error?._tag;

/** Runs `work` over `items` with at most `limit` in flight; results keep order. */
const mapLimited = async (items, limit, work) => {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

/**
 * Archive state on OpenCode. Calls throw OpenCode's tagged errors; reads of a
 * session OpenCode does not know resolve `undefined`.
 *
 * @param {object} options
 * @param {(directory?: string) => any} options.clientFor
 */
export const createOpenCodeSessionArchive = ({ clientFor }) => {
  const readSession = async (sessionID) => {
    try {
      return await clientFor().session.get({ sessionID });
    } catch (error) {
      if (errorTag(error) === 'SessionNotFoundError') return undefined;
      throw error;
    }
  };
  return {
    setArchived: (sessionID, archived) => clientFor().session.update({ sessionID, archived }),
    readArchivedAt: async (sessionID) => {
      const session = await readSession(sessionID);
      return session ? session.time?.archived ?? null : undefined;
    },
  };
};

/**
 * @param {object} options
 * @param {ReturnType<typeof import('./archive-store.js').createArchiveStore>} options.store
 * @param {ReturnType<typeof createOpenCodeSessionArchive>} options.openCode
 */
export const createSessionArchive = ({ store, openCode }) => {
  const sessionChains = new Map();
  const runForSession = (id, work) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  const warnFailure = (action, id, error) => {
    if (errorTag(error) === 'SessionNotFoundError') return;
    console.warn(`[openchamber-sessions] could not ${action} ${id}:`, error?.message ?? error);
  };

  // Unknown state stays a failure so background work cannot treat a failed
  // read as permission to resume or deliver a result.
  const archivedAt = async (sessionID) => {
    const value = await openCode.readArchivedAt(sessionID);
    if (value === undefined) throw new Error(`Session ${sessionID} was not found`);
    return value;
  };

  const applyBatch = (ids, archived) => mapLimited(ids, CONCURRENCY, (id) => runForSession(id, async () => {
    try {
      await openCode.setArchived(id, archived);
      const stamp = await archivedAt(id);
      if ((stamp !== null) !== archived) throw new Error('Archive state changed before confirmation');
      const { failedIds } = await store.forget([id]);
      if (failedIds.length) throw new Error('Could not retire the legacy archive entry');
      return { id, archivedAt: stamp };
    } catch (error) {
      warnFailure(archived ? 'archive' : 'unarchive', id, error);
      return null;
    }
  }));

  /**
   * Pushes legacy flags through the same per-session chain as user writes.
   * Successful pushes (or confirmed missing sessions) retire their entry.
   * Failed writes keep the source and are retried on the next startup.
   */
  const migrateLegacy = async () => {
    const pending = Object.keys(await store.getAll());
    if (pending.length === 0) return 0;
    await mapLimited(pending, CONCURRENCY, (id) => runForSession(id, async () => {
      const entry = await store.entry(id);
      if (entry === undefined) return;
      try {
        await openCode.setArchived(id, entry !== null);
      } catch (error) {
        if (errorTag(error) !== 'SessionNotFoundError') {
          warnFailure('migrate archive state for', id, error);
          return;
        }
      }
      const { failedIds } = await store.forget([id]);
      if (failedIds.length) warnFailure('retire legacy archive state for', id, new Error('Archive file write failed'));
    }));

    return Object.keys(await store.getAll()).length;
  };

  return {
    archive: async (ids) => {
      const results = await applyBatch(ids, true);
      return { archived: results.filter(Boolean), failedIds: ids.filter((_, index) => results[index] === null) };
    },
    unarchive: async (ids) => {
      const results = await applyBatch(ids, false);
      return { restored: results.filter(Boolean), failedIds: ids.filter((_, index) => results[index] === null) };
    },
    archivedAt,
    isArchived: async (sessionID) => typeof (await archivedAt(sessionID)) === 'number',
    migrateLegacy,
  };
};
