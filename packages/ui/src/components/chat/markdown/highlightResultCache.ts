// Bounded LRU for Shiki highlight results.
//
// Used on both the main-thread worker client and inside the markdown-shiki
// worker so unchanged code is never re-tokenized. Keys are exact
// (lang + source [+ theme]); eviction is by entry count and approximate byte
// size so long sessions cannot grow unbounded.

export type HighlightResultCacheOptions = {
  maxEntries: number;
  maxBytes: number;
};

const utf8Bytes = (value: string): number => {
  // Prefer TextEncoder when available (browser / modern Bun); fall back to
  // UTF-16 length × 2 as a conservative upper bound for older runtimes.
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(value).length;
  }
  return value.length * 2;
};

export class HighlightResultCache<T> {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly sizeOf: (key: string, value: T) => number;
  private readonly map = new Map<string, T>();
  private totalBytes = 0;

  constructor(
    options: HighlightResultCacheOptions,
    sizeOf: (key: string, value: T) => number,
  ) {
    this.maxEntries = Math.max(1, options.maxEntries);
    this.maxBytes = Math.max(1, options.maxBytes);
    this.sizeOf = sizeOf;
  }

  get size(): number {
    return this.map.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get(key: string): T | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Refresh LRU order.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: T): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= this.sizeOf(key, existing);
      this.map.delete(key);
    }

    const entrySize = this.sizeOf(key, value);
    while (
      this.map.size > 0
      && (this.map.size >= this.maxEntries || this.totalBytes + entrySize > this.maxBytes)
    ) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      const oldestValue = this.map.get(oldest);
      if (oldestValue !== undefined) {
        this.totalBytes -= this.sizeOf(oldest, oldestValue);
      }
      this.map.delete(oldest);
      // Always allow a single oversized entry so huge files still cache once.
      if (this.map.size === 0) break;
    }

    this.map.set(key, value);
    this.totalBytes += entrySize;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

/** Byte size for string→string highlight HTML caches (key + value). */
export const stringPairSize = (key: string, value: string): number =>
  utf8Bytes(key) + utf8Bytes(value);

/** Byte size for string→string[] line caches. */
export const stringLinesSize = (key: string, value: string[]): number => {
  let total = utf8Bytes(key);
  for (const line of value) total += utf8Bytes(line);
  return total;
};
