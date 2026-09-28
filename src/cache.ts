export interface PersistedCacheEntry {
  key: string;
  value: string;
  expiresAt: number | null;
  willIds: string[];
}

export interface CachePersistenceAdapter {
  readAll(): Promise<PersistedCacheEntry[]>;
  write(entry: PersistedCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ReadCacheOptions {
  ttlMs?: number;
  now?: () => number;
  persistence?: CachePersistenceAdapter;
  /**
   * Maximum number of entries to keep in the cache. When the number of entries
   * exceeds this limit, the least-recently-used entries are evicted (and removed
   * from persistence). When omitted, the cache is unbounded.
   */
  maxEntries?: number;
}

interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number | null;
  willIds: Set<string>;
  locale: string | undefined;
}

function serializeCacheValue(value: unknown): string {
  return JSON.stringify(value, function (key, currentValue) {
    // `Date` defines `toJSON`, so by the time a replacer sees it, it has
    // already been converted to an ISO string. Read the pre-toJSON value off
    // the holder (`this`) to tell a real Date apart from a plain ISO string.
    const original = (this as Record<string, unknown>)[key];
    if (original instanceof Date) {
      return { __type: 'date', value: original.toISOString() };
    }
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }
    return currentValue;
  });
}

function deserializeCacheValue<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === 'object' &&
      '__type' in currentValue &&
      'value' in currentValue &&
      typeof currentValue.value === 'string'
    ) {
      if (currentValue.__type === 'bigint') {
        return BigInt(currentValue.value);
      }
      if (currentValue.__type === 'date') {
        return new Date(currentValue.value);
      }
    }
    return currentValue;
  }) as T;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (typeof currentValue === 'bigint') {
      return { __type: 'bigint', value: currentValue.toString() };
    }

    if (Array.isArray(currentValue)) {
      return currentValue;
    }

    if (currentValue && typeof currentValue === 'object') {
      const sortedEntries = Object.entries(currentValue as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return Object.fromEntries(sortedEntries);
    }

    return currentValue;
  });
}

/**
 * Builds a locale-agnostic cache key for a read method.
 *
 * Cache key design:
 * - Keys are derived ONLY from the method name and its non-locale arguments.
 * - Locale-dependent inputs (e.g. `locale`, `language`, `i18n`) are stripped
 *   before serialization so the same underlying data maps to a single key
 *   regardless of the active language.
 * - Locale-dependent formatting (currency, number, date formatting) MUST be
 *   applied AFTER retrieving the cached value, never before caching it.
 *
 * This guarantees that switching languages mid-app does not return stale data
 * formatted for the previous locale.
 */
export function createReadCacheKey(method: string, args: Record<string, unknown>): string {
  return `${method}:${stableStringify(args)}`;
}

/**
 * A memory-backed read cache with optional persistent storage.
 *
 * IMPORTANT: If a persistence adapter is configured, hydration (loading stored
 * entries) happens asynchronously in the constructor. Callers must await
 * `cache.ready()` before calling `cache.get()` to ensure all persisted entries
 * are available. Calling `get()` before `ready()` completes will incorrectly
 * return a cache miss for data that is being loaded.
 *
 * Without persistence, the cache is immediately ready and can be used after
 * construction.
 *
 * LOCALE AWARENESS: Cache keys include the locale, but a locale change must not
 * return results cached under the previous locale. When the active locale
 * changes (via the constructor option or `setLocale()`), all entries belonging
 * to the previous locale are invalidated so stale translations are never
 * served.
 */
export class ReadCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly persistence: CachePersistenceAdapter | undefined;
  private readonly maxEntries: number | undefined;
  private readonly readyPromise: Promise<void>;
  /**
   * Keys written or deleted after construction but before hydration completes.
   * Hydration must not overwrite these with older persisted values.
   */
  private readonly touchedKeys = new Set<string>();
  /**
   * Set when clear() is called before hydration completes. Hydration must not
   * repopulate the cache once it resolves.
   */
  private clearedBeforeHydration = false;

  constructor(options: ReadCacheOptions = {}) {
    const ttlMs = options.ttlMs ?? 60_000;
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new Error(
        `ReadCache: ttlMs must be a finite non-negative number, received ${String(ttlMs)}`,
      );
    }

    this.ttlMs = ttlMs;
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.maxEntries = options.maxEntries;
    this.readyPromise = this.hydrate();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
  }

  /**
   * Returns the locale currently associated with this cache instance.
   */
  getLocale(): string | undefined {
    return this.locale;
  }

  /**
   * Updates the active locale. If the locale actually changed, every entry
   * cached under the previous locale is invalidated (in memory and, when
   * configured, in persistent storage) so that subsequent reads cannot return
   * stale translations.
   */
  async setLocale(locale: string | undefined): Promise<void> {
    if (locale === this.locale) {
      return;
    }

    const previousLocale = this.locale;
    this.locale = locale;

    await this.readyPromise;

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.locale === previousLocale) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));
  }

  /**
   * Synchronously retrieves a cached value by key.
   *
   * WARNING: If this cache was constructed with persistence enabled, you MUST
   * call and await `ready()` before calling this method. Calling `get()` before
   * `ready()` completes will return undefined for entries that are currently
   * being loaded from persistent storage.
   *
   * @param key - The cache key to look up
   * @returns The cached value if found and not expired, or undefined
   */
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }

    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }

    // Refresh recency for LRU ordering: re-inserting moves the key to the end.
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.value as T;
  }

  set(key: string, value: unknown, willIds: Iterable<string> = []): void {
    if (this.ttlMs === 0) {
      this.touchedKeys.add(key);
      void this.persistence?.delete(key);
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      expiresAt: this.now() + this.ttlMs,
      willIds: new Set(willIds),
      locale: this.locale,
    };

    this.touchedKeys.add(key);
    // Delete before set so an updated key moves to the most-recent position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    void this.persistence
      ?.write(this.toPersistedEntry(entry))
      .catch(() => {
        // Silently ignore persistence failures to prevent unhandled rejections
        // The cache remains functional in-memory; only durability is lost
      });

    this.evictIfNeeded();
  }

  /**
   * Removes a single entry from the cache (both in-memory and persisted).
   *
   * Useful when a caller knows the cached value is stale and wants to force a
   * subsequent `get()` to miss so the value is re-fetched from the source of
   * truth (e.g. the contract).
   *
   * @param key - The cache key to evict
   */
  async invalidate(key: string): Promise<void> {
    await this.readyPromise;
    await this.delete(key);
  }

  async invalidateByWillId(willId: string): Promise<void> {
    await this.readyPromise;

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.willIds.has(willId)) {
        keysToDelete.push(key);
      }
    }

    await Promise.all(keysToDelete.map((key) => this.delete(key)));
  }

  clear(): void {
    this.clearedBeforeHydration = true;
    this.entries.clear();
    void this.persistence?.clear().catch(() => {
      // Silently ignore persistence failures to prevent unhandled rejections
      // The cache is cleared in-memory; only durability guarantee is lost
    });
  }

  private evictIfNeeded(): void {
    if (this.maxEntries === undefined) {
      return;
    }

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }

      this.entries.delete(oldestKey);
      this.touchedKeys.add(oldestKey);
      void this.persistence?.delete(oldestKey).catch(() => {
        // Silently ignore persistence failures to prevent unhandled rejections
        // The entry is evicted in-memory; only durability guarantee is lost
      });
    }
  }

  private async delete(key: string): Promise<void> {
    this.touchedKeys.add(key);
    this.entries.delete(key);
    await this.persistence?.delete(key);
  }

  private async hydrate(): Promise<void> {
    if (!this.persistence) {
      return;
    }

    const persistedEntries = await this.persistence.readAll();

    // If clear() was called while hydration was in flight, the cache must
    // remain empty once ready() resolves. Do not repopulate it.
    if (this.clearedBeforeHydration) {
      return;
    }

    const now = this.now();

    for (const persistedEntry of persistedEntries) {
      if (persistedEntry.expiresAt !== null && persistedEntry.expiresAt <= now) {
        await this.persistence.delete(persistedEntry.key);
        continue;
      }

      // Never let an older persisted entry replace a value that was written
      // (or deleted) after construction but before hydration completed.
      if (this.touchedKeys.has(persistedEntry.key)) {
        continue;
      }

      this.entries.set(persistedEntry.key, {
        key: persistedEntry.key,
        value: deserializeCacheValue(persistedEntry.value),
        expiresAt: persistedEntry.expiresAt,
        willIds: new Set(persistedEntry.willIds),
        locale: this.locale,
      });
    }

    this.evictIfNeeded();
  }

  private toPersistedEntry(entry: CacheEntry): PersistedCacheEntry {
    return {
      key: entry.key,
      value: serializeCacheValue(entry.value),
      expiresAt: entry.expiresAt,
      willIds: Array.from(entry.willIds),
    };
  }
}
