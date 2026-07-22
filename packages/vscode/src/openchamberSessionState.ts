/**
 * OpenChamber session state for the VS Code runtime: archive flags and
 * per-session metadata.
 *
 * Archive writes go to OpenCode, which owns the archive timestamp and command
 * cleanup. Session reads keep its authoritative `time.archived` unchanged.
 *
 * Metadata lives on the OpenCode session record (`PATCH /api/session/{id}`,
 * OpenCode 2.0.15+). Before that it lived in `sessions-metadata.json` in the
 * same directory. An entry still in that file is the newest metadata its
 * session has: reads lay it over OpenCode's record, and the session's next
 * write pushes the result to OpenCode and drops the entry. The web server
 * sweeps the rest.
 *
 * Two processes may write these files, so nothing is cached between calls:
 * every read parses the file and every write re-reads it first, then replaces
 * it atomically. The files are a few kilobytes, and the reads sit behind
 * session list requests, not on a hot path.
 *
 * Metadata writes are a JSON Merge Patch (RFC 7386): nested objects merge key
 * by key and `null` deletes. OpenCode replaces the whole object on PATCH, so
 * the merge happens here, and two features writing into the same `openchamber`
 * namespace (goal mode, session assist, pinned context, review links) do not
 * erase each other.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const METADATA_FILE_NAME = 'sessions-metadata.json';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
/** Free-form JSON attached to a session; the same shape the shared UI's `Metadata` has. */
export type SessionMetadata = JsonObject;

export type SessionArchiveOnOpenCode = (sessionID: string, archivedAt: number | null) => Promise<void>;
type StoredSessionMetadata = Record<string, SessionMetadata>;

export type SessionStateFs = {
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  writeFile: (filePath: string, data: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<string | undefined>;
};

/** One session's metadata on OpenCode. `read` resolves `null` for a session OpenCode does not know. */
export type SessionMetadataOnOpenCode = {
  read: (sessionID: string) => Promise<SessionMetadata | null>;
  write: (sessionID: string, metadata: SessionMetadata) => Promise<void>;
};

type SessionStateStoreOptions = {
  dataDir: string;
  fsPromises?: SessionStateFs;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// JSON boundary: every byte from disk or from a proxied response enters as a
// `JsonValue` here, and the guards below are the only narrowing in the module.
// ---------------------------------------------------------------------------

/** Parses text into a JSON value; `null` when it is not JSON. */
export const parseJson = (text: string): JsonValue | null => {
  try {
    // SAFETY: JSON.parse can only produce strings, numbers, booleans, null,
    // arrays, and plain objects, which is exactly the JsonValue union.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';

const isTimestamp = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A session id as the bridge or a file carries it: a non-empty trimmed string, else `null`. */
export const asSessionId = (value: JsonValue | undefined): string | null => {
  if (!isJsonString(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const asTimestamp = (value: JsonValue | undefined): number | null => (isTimestamp(value) ? value : null);

export const asSessionIdList = (value: JsonValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const id = asSessionId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

export const asSessionMetadata = (value: JsonValue | undefined): SessionMetadata | null =>
  isJsonObject(value) ? value : null;

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
export const mergeMetadataPatch = (current: SessionMetadata | undefined, patch: SessionMetadata): SessionMetadata => {
  const base: SessionMetadata = current ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    const previous = base[key];
    base[key] = isJsonObject(value) ? mergeMetadataPatch(isJsonObject(previous) ? previous : undefined, value) : value;
  }
  return base;
};

/** The shared OpenChamber config directory, the web server's default data dir. */
export const getOpenChamberDataDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const isMissingFileError = (error: Error): boolean => 'code' in error && error.code === 'ENOENT';

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createSessionStateStore = ({
  dataDir,
  fsPromises = fs.promises,
  now = Date.now,
}: SessionStateStoreOptions) => {
  const metadataPath = path.join(dataDir, METADATA_FILE_NAME);
  let writeChain: Promise<unknown> = Promise.resolve();

  /**
   * Parses one state file. A missing file is the normal first run and reads
   * as empty; unreadable bytes are moved aside so the next write cannot
   * overwrite what the user had, and read as empty too. An I/O failure other
   * than "missing" is reported as `null`: unknown, not empty.
   */
  const readJsonObjectFile = async (filePath: string): Promise<JsonObject | null> => {
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && isMissingFileError(error)) return {};
      console.warn(`[openchamber-sessions] could not read ${path.basename(filePath)}:`, describeError(error));
      return null;
    }
    const parsed = parseJson(raw);
    if (isJsonObject(parsed)) return parsed;
    const backup = `${filePath}.corrupt-${now()}`;
    await fsPromises.rename(filePath, backup).catch(() => undefined);
    console.warn(`[openchamber-sessions] ${path.basename(filePath)} was not a JSON object and was moved to ${backup}`);
    return {};
  };

  const writeJsonObjectFile = (filePath: string, value: JsonObject): Promise<void> => {
    const write = async () => {
      await fsPromises.mkdir(dataDir, { recursive: true });
      // Temp file in the same directory so the rename is atomic on one device.
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(value), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    };
    const next = writeChain.then(write, write);
    writeChain = next.catch(() => undefined);
    return next;
  };

  const readMetadata = async (): Promise<StoredSessionMetadata | null> => {
    const parsed = await readJsonObjectFile(metadataPath);
    if (!parsed) return null;
    const result: StoredSessionMetadata = {};
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asSessionId(sessionID);
      if (id && isJsonObject(value)) result[id] = value;
    }
    return result;
  };

  /** Sets or clears the archive flag for a batch; `null` clears. */
  const applyArchive = async (ids: string[], archivedAt: number | null, write: SessionArchiveOnOpenCode) => {
    const targets = asSessionIdList(ids);
    const applied = new Set<string>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
      while (cursor < targets.length) {
        const id = targets[cursor++];
        try {
          await write(id, archivedAt);
          applied.add(id);
        } catch (error) {
          console.warn('[openchamber-sessions] failed to update archive state:', describeError(error));
        }
      }
    }));
    return { applied: targets.filter((id) => applied.has(id)), failedIds: targets.filter((id) => !applied.has(id)) };
  };

  return {
    metadataPath,
    /** `{ [sessionID]: metadata }`, or `null` when the file could not be read. */
    readMetadata,
    archive: async (ids: string[], archivedAt: number | null, write: SessionArchiveOnOpenCode) => {
      const stamp = archivedAt ?? now();
      const { applied, failedIds } = await applyArchive(ids, stamp, write);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    },
    unarchive: async (ids: string[], write: SessionArchiveOnOpenCode) => {
      const { applied, failedIds } = await applyArchive(ids, null, write);
      return { restored: applied.map((id) => ({ id, archivedAt: null })), failedIds };
    },
    /** The session's full metadata: a legacy entry laid over OpenCode's record. `{}` for an unknown session. */
    getMetadata: async (sessionID: string, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      const legacy = stored[sessionID];
      return legacy ? { ...(upstream ?? {}), ...legacy } : upstream ?? {};
    },
    /**
     * Applies a merge patch on OpenCode and resolves with the session's full
     * metadata afterwards. A legacy entry is folded in and then dropped from
     * the file, since OpenCode now holds it.
     */
    setMetadata: async (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      if (!upstream) throw new Error(`session ${sessionID} was not found`);
      const legacy = stored[sessionID];
      const merged = mergeMetadataPatch(legacy ? { ...upstream, ...legacy } : upstream, patch);
      await openCode.write(sessionID, merged);
      if (legacy) {
        // Re-read: the web server or another window may have changed the file.
        const latest = await readMetadata();
        if (latest && latest[sessionID]) {
          const next = { ...latest };
          delete next[sessionID];
          await writeJsonObjectFile(metadataPath, next).catch((error) => {
            // OpenCode holds the record; a stale entry is pushed again later.
            console.warn('[openchamber-sessions] could not update the legacy metadata file:', describeError(error));
          });
        }
      }
      return merged;
    },
  };
};

export type SessionStateStore = ReturnType<typeof createSessionStateStore>;

/**
 * Folds legacy metadata not yet migrated over OpenCode's record. A value
 * that is not a session record passes through untouched.
 */
const overlaySessionRecord = (
  value: JsonValue,
  stored: StoredSessionMetadata | null,
): JsonValue => {
  if (!isJsonObject(value)) return value;
  const id = asSessionId(value.id);
  if (!id) return value;
  let result: JsonObject = value;
  if (stored) {
    const ours = stored[id];
    if (ours) {
      const theirs = isJsonObject(result.metadata) ? result.metadata : {};
      result = { ...result, metadata: { ...theirs, ...ours } };
    }
  }
  return result;
};

/**
 * Applies `overlaySessionRecord` to a proxied `GET /api/session` list or
 * `GET /api/session/:id` body. Both shapes OpenCode uses are handled: a bare
 * record/array and the `{ data }` envelope. Anything else passes through.
 */
export const overlaySessionResponseBody = (
  body: JsonValue,
  stored: StoredSessionMetadata | null,
): JsonValue => {
  if (!stored) return body;
  if (Array.isArray(body)) return body.map((entry) => overlaySessionRecord(entry, stored));
  if (!isJsonObject(body)) return body;
  const data = body.data;
  if (Array.isArray(data)) {
    return { ...body, data: data.map((entry) => overlaySessionRecord(entry, stored)) };
  }
  if (isJsonObject(data)) {
    return { ...body, data: overlaySessionRecord(data, stored) };
  }
  return overlaySessionRecord(body, stored);
};

/** `GET /api/session` (list) and `GET /api/session/:id` (one record) carry session records to overlay. */
export const isSessionRecordPath = (pathname: string): boolean =>
  pathname === '/api/session' || /^\/api\/session\/[^/]+$/.test(pathname);
