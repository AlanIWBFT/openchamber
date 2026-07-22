import { hasMessage, hasTag } from './contracts.js';
import type { createArchiveStore } from './archive-store.js';
import type { SessionClient } from './opencode-client-contract.js';

const CONCURRENCY = 4;

const isArchiveTimestamp = (value: unknown): value is number => typeof value === 'number';

const mapLimited = async <Item, Result>(items: Item[], limit: number, work: (item: Item) => Promise<Result>) => {
  const results = new Array<Result>(items.length);
  const values = items.values();
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = values.next();
      if (item.done) return;
      results[index] = await work(item.value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

export interface ArchiveReadOptions {
  signal?: AbortSignal | undefined;
}

export interface OpenCodeSessionArchive {
  setArchived: (sessionID: string, archived: boolean) => Promise<void>;
  readArchivedAt: (sessionID: string, options?: ArchiveReadOptions) => Promise<number | null | undefined>;
}

export const createOpenCodeSessionArchive = ({ clientFor }: { clientFor: () => SessionClient }): OpenCodeSessionArchive => ({
  setArchived: (sessionID, archived) => clientFor().session.update({ sessionID, archived }),
  readArchivedAt: async (sessionID, { signal } = {}) => {
    try {
      const session = await clientFor().session.get({ sessionID }, { signal });
      return session.time?.archived ?? null;
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') return undefined;
      throw error;
    }
  },
});

interface SessionArchiveOptions {
  store: ReturnType<typeof createArchiveStore>;
  openCode: OpenCodeSessionArchive;
}

export const createSessionArchive = ({ store, openCode }: SessionArchiveOptions) => {
  const sessionChains = new Map<string, Promise<void>>();
  const runForSession = <Result>(id: string, work: () => Promise<Result>) => {
    const previous = sessionChains.get(id) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    sessionChains.set(id, settled);
    void settled.then(() => {
      if (sessionChains.get(id) === settled) sessionChains.delete(id);
    });
    return next;
  };

  const pushToOpenCode = async (id: string, archived: boolean) => {
    try {
      await openCode.setArchived(id, archived);
      return 'opencode';
    } catch (error) {
      if (hasTag(error) && error._tag === 'SessionNotFoundError') return 'unknown-session';
      console.warn(`[openchamber-sessions] could not ${archived ? 'archive' : 'unarchive'} ${id}:`, (hasMessage(error) ? error.message : undefined) ?? error);
      return 'failed';
    }
  };

  const archivedAt = async (sessionID: string) => {
    const at = await openCode.readArchivedAt(sessionID);
    if (at === undefined) throw new Error(`Session ${sessionID} was not found`);
    return at;
  };

  const applyBatch = async (ids: string[], archived: boolean) => {
    const result = await mapLimited(ids, CONCURRENCY, id => runForSession(id, async () => {
      if (await pushToOpenCode(id, archived) !== 'opencode') return undefined;
      try {
        const at = await archivedAt(id);
        if ((at !== null) !== archived) throw new Error('Archive state changed before confirmation');
        return (await store.forget([id])).failedIds.length ? undefined : at;
      } catch (error) {
        console.warn(`[openchamber-sessions] could not confirm archive state for ${id}:`, error);
        return undefined;
      }
    }));
    return { result, failedIds: ids.filter((_, index) => result[index] === undefined) };
  };

  const archiveState = async (sessionID: string, { signal }: ArchiveReadOptions = {}) => {
    try {
      const at = await openCode.readArchivedAt(sessionID, { signal });
      if (at === undefined) return 'missing';
      return Number.isFinite(at) ? 'archived' : 'active';
    } catch {
      return 'unknown';
    }
  };

  const migrateEntry = (id: string) => runForSession(id, async () => {
    const entry = await store.entry(id);
    if (entry === undefined) return;
    if (await pushToOpenCode(id, entry !== null) === 'failed') return;
    await store.forget([id]);
  });

  const migrateLegacy = async () => {
    const pending = Object.keys(await store.getAll());
    if (pending.length === 0) return 0;
    await mapLimited(pending, CONCURRENCY, migrateEntry);
    return Object.keys(await store.getAll()).length;
  };

  return {
    archive: async (ids: string[]) => {
      const { result, failedIds } = await applyBatch(ids, true);
      return { archived: ids.flatMap((id, i) => isArchiveTimestamp(result[i]) ? [{ id, archivedAt: result[i] }] : []), failedIds };
    },
    unarchive: async (ids: string[]) => {
      const { result, failedIds } = await applyBatch(ids, false);
      return { restored: ids.flatMap((id, i) => result[i] === null ? [{ id, archivedAt: null }] : []), failedIds };
    },
    archivedAt,
    isArchived: async (sessionID: string) => isArchiveTimestamp(await archivedAt(sessionID)),
    archiveState,
    migrateLegacy,
  };
};
