// Bounded LRU for Shiki highlight results.
//
// Used on the main-thread worker client and inside the markdown-shiki worker so
// unchanged code is never re-tokenized. Keys are short content fingerprints
// (not the full source) so cache maps do not duplicate large strings. Entry
// byte sizes are recorded once at insert time — get/evict never re-walk the
// payload.

export type HighlightResultCacheOptions = {
  maxEntries: number;
  maxBytes: number;
};

type CacheEntry<T> = {
  value: T;
  bytes: number;
};

/** UTF-16 storage estimate for a JS string (chars × 2). Avoids TextEncoder allocs. */
export const utf16Bytes = (value: string): number => value.length * 2;

/**
 * Short stable fingerprint for cache keys: length + FNV-1a 32-bit.
 * Collision of same length + same hash is vanishingly rare at session scale;
 * highlight results are pure functions of (kind, lang, theme, source).
 */
export const contentFingerprint = (value: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${value.length.toString(36)}_${(h >>> 0).toString(36)}`;
};

/** Approximate byte cost of token-run lines without JSON.stringify. */
export const estimateTokenRunsBytes = (
  lines: ReadonlyArray<ReadonlyArray<readonly [number, string, number]>>,
): number => {
  let total = 0;
  for (const line of lines) {
    total += 4;
    for (const run of line) {
      total += 8 + utf16Bytes(run[1]);
    }
  }
  return total;
};

export class HighlightResultCache<T> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly map = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(options: HighlightResultCacheOptions) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    // Refresh LRU order without recomputing size.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= existing.bytes;
      this.map.delete(key);
    }

    const entryBytes = Math.max(0, bytes);
    while (
      this.map.size > 0
      && (this.map.size >= this.maxEntries || this.totalBytes + entryBytes > this.maxBytes)
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const oldestEntry = this.map.get(oldest);
      if (oldestEntry !== undefined) this.totalBytes -= oldestEntry.bytes;
      this.map.delete(oldest);
      // Always allow a single oversized entry so huge files still cache once.
      if (this.map.size === 0) break;
    }

    this.map.set(key, { value, bytes: entryBytes });
    this.totalBytes += entryBytes;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}
