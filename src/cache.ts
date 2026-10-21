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
  /**
   * Callback invoked when a persistence adapter operation (write, delete, or
   * clear) fails. Receives the affected key and the error. The cache continues
   * to function in-memory; only durability is affected.
   */
  onPersistenceFailure?: (key: string, error: unknown) => void;
  /**
   * When `true`, a persistence write failure in `set()` rolls back the
   * in-memory cache entry (removes it) so memory and persistence stay in sync.
   * Defaults to `false` (the in-memory entry is kept even if persistence
   * fails). When `false`, only the `onPersistenceFailure` callback is invoked.
   */
  rollbackOnPersistenceFailure?: boolean;
}

interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number | null;
  willIds: Set<string>;
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

export function deserializeCacheValue<T>(value: string): T {
  return JSON.parse(value, (_key, currentValue) => {
    if (
      currentValue &&
      typeof currentValue === 'object' &&
      '__type' in currentValue &&
      'value' in currentValue &&
      typeof currentValue.value === 'string'
    ) {
      const type = currentValue.__type as string;
      if (type === 'bigint') {
        return BigInt(currentValue.value);
      }
      if (type === 'date') {
        return new Date(currentValue.value);
      }
      console.warn(
        `[SoroWill] Cache: unknown __type "${type}" encountered during deserialization; returning raw value.`,
      );
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
  private readonly onPersistenceFailure: ((key: string, error: unknown) => void) | undefined;
  private readonly rollbackOnPersistenceFailure: boolean;
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
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs)) {
      throw new Error(
        `ReadCache: ttlMs must be a finite number, received ${String(ttlMs)}`,
      );
    }
    if (ttlMs < 0) {
      console.warn(
        `[SoroWill] Cache: negative ttlMs ${ttlMs}ms is not allowed; treating as 0 (immediate expiration).`,
      );
    }
    this.ttlMs = Math.max(0, ttlMs);

    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
    this.maxEntries = options.maxEntries;
    this.onPersistenceFailure = options.onPersistenceFailure;
    this.rollbackOnPersistenceFailure = options.rollbackOnPersistenceFailure ?? false;
    this.readyPromise = this.hydrate();
  }

  async ready(): Promise<void> {
    await this.readyPromise;
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
      void this.persistence
        ?.delete(key)
        .catch((err) => this.onPersistenceFailure?.(key, err));
      return;
    }

    const entry: CacheEntry = {
      key,
      value,
      expiresAt: this.now() + this.ttlMs,
      willIds: new Set(willIds),
    };

    this.touchedKeys.add(key);
    // Delete before set so an updated key moves to the most-recent position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    void this.persistence
      ?.write(this.toPersistedEntry(entry))
      .catch((err) => {
        // Report persistence failure via callback if provided
        this.onPersistenceFailure?.(key, err);
        // Optionally roll back the in-memory entry so memory and persistence stay in sync
        if (this.rollbackOnPersistenceFailure) {
          this.entries.delete(key);
          this.touchedKeys.delete(key);
        }
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
    void this.persistence
      ?.clear()
      .catch((err) => this.onPersistenceFailure?.('__clear__', err));
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
      void this.persistence
        ?.delete(oldestKey)
        .catch((err) => this.onPersistenceFailure?.(oldestKey, err));
    }
  }

  private async delete(key: string): Promise<void> {
    this.touchedKeys.add(key);
    this.entries.delete(key);
    try {
      await this.persistence?.delete(key);
    } catch (err) {
      this.onPersistenceFailure?.(key, err);
    }
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

/**
 * In-memory cache persistence adapter. Stores entries in RAM only;
 * data is lost when the process terminates.
 */
export class MemoryCachePersistenceAdapter implements CachePersistenceAdapter {
  private entries: PersistedCacheEntry[] = [];

  async readAll(): Promise<PersistedCacheEntry[]> {
    return [...this.entries];
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    const index = this.entries.findIndex((e) => e.key === entry.key);
    if (index >= 0) {
      this.entries[index] = entry;
    } else {
      this.entries.push(entry);
    }
  }

  async delete(key: string): Promise<void> {
    this.entries = this.entries.filter((e) => e.key !== key);
  }

  async clear(): Promise<void> {
    this.entries = [];
  }
}

/**
 * LocalStorage-based cache persistence adapter. Stores entries in browser
 * localStorage under a namespaced key.
 */
export class LocalStorageCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly namespace: string;

  constructor(namespace: string = 'sorowill-cache') {
    this.namespace = namespace;
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    try {
      const data = localStorage.getItem(this.namespace);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    try {
      const entries = await this.readAll();
      const index = entries.findIndex((e) => e.key === entry.key);
      if (index >= 0) {
        entries[index] = entry;
      } else {
        entries.push(entry);
      }
      localStorage.setItem(this.namespace, JSON.stringify(entries));
    } catch {
      // Silently fail if localStorage is unavailable or quota exceeded
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const entries = await this.readAll();
      const filtered = entries.filter((e) => e.key !== key);
      localStorage.setItem(this.namespace, JSON.stringify(filtered));
    } catch {
      // Silently fail if localStorage is unavailable
    }
  }

  async clear(): Promise<void> {
    try {
      localStorage.removeItem(this.namespace);
    } catch {
      // Silently fail if localStorage is unavailable
    }
  }
}

/**
 * IndexedDB-based cache persistence adapter. Stores entries in IndexedDB
 * for more reliable and larger-capacity persistence.
 */
export class IndexedDbCachePersistenceAdapter implements CachePersistenceAdapter {
  private readonly dbName: string;
  private readonly storeName: string;
  private db: IDBDatabase | null = null;

  constructor(dbName: string = 'sorowill-cache', storeName: string = 'entries') {
    this.dbName = dbName;
    this.storeName = storeName;
  }

  private async ensureDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, 1);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName, { keyPath: 'key' });
        }
      };
    });
  }

  async readAll(): Promise<PersistedCacheEntry[]> {
    try {
      const db = await this.ensureDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.storeName, 'readonly');
        const store = transaction.objectStore(this.storeName);
        const request = store.getAll();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || []);
      });
    } catch {
      return [];
    }
  }

  async write(entry: PersistedCacheEntry): Promise<void> {
    try {
      const db = await this.ensureDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.put(entry);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const db = await this.ensureDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.delete(key);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.ensureDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.clear();

        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch {
      // Silently fail if IndexedDB is unavailable
    }
  }
}
