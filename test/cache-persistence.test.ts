import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { LocalStorageCachePersistenceAdapter, MemoryCachePersistenceAdapter, PersistedCacheEntry, ReadCache, IndexedDbCachePersistenceAdapter } from '../src/cache';

/**
 * A real key-value-backed Storage mock. The adapter under test persists each
 * entry under its own key plus a separate `<namespace>:__keys__` index (an
 * O(1)-write scheme — see #205), so a mock that only simulates a single
 * static key/value pair can't exercise it correctly.
 */
function createMockStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    clear: () => {
      map.clear();
    },
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('LocalStorageCachePersistenceAdapter', () => {
  let storage: Storage;
  const namespace = 'test-namespace';
  const keysIndexKey = `${namespace}:__keys__`;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it('readAll returns empty array when no storage key exists', async () => {
    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('readAll returns empty array and clears the keys index when JSON is corrupted', async () => {
    storage.setItem(keysIndexKey, '{ invalid json }');

    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    const result = await adapter.readAll();

    expect(result).toEqual([]);
    expect(storage.getItem(keysIndexKey)).toBeNull();
  });

  it('readAll handles JSON that is not an array', async () => {
    storage.setItem(keysIndexKey, '{"not": "an array"}');

    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('readAll successfully parses valid cache entries', async () => {
    const entries: PersistedCacheEntry[] = [
      {
        key: 'test:key1',
        value: '"cached value"',
        expiresAt: Date.now() + 60000,
        willIds: [],
      },
    ];

    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    for (const entry of entries) {
      await adapter.write(entry);
    }
    const result = await adapter.readAll();

    expect(result).toEqual(entries);
  });

  it('write stores entries in localStorage', async () => {
    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);

    const stored = storage.getItem(`${namespace}:${entry.key}`);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual(entry);
    expect(JSON.parse(storage.getItem(keysIndexKey)!)).toContain(entry.key);
  });

  it('delete removes entry from localStorage', async () => {
    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    await adapter.write({ key: 'key1', value: '"val1"', expiresAt: null, willIds: [] });
    await adapter.write({ key: 'key2', value: '"val2"', expiresAt: null, willIds: [] });

    await adapter.delete('key1');

    const remaining = await adapter.readAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.key).toBe('key2');
    expect(storage.getItem(`${namespace}:key1`)).toBeNull();
  });

  it('clear removes the storage key', async () => {
    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    await adapter.write({ key: 'key1', value: '"val1"', expiresAt: null, willIds: [] });

    await adapter.clear();

    expect(storage.getItem(keysIndexKey)).toBeNull();
    expect(storage.getItem(`${namespace}:key1`)).toBeNull();
  });

  it('ReadCache construction does not throw with corrupted LocalStorageCachePersistenceAdapter', async () => {
    storage.setItem(keysIndexKey, '{ invalid json }');

    const adapter = new LocalStorageCachePersistenceAdapter(storage, { key: namespace });
    const cache = new ReadCache({ persistence: adapter });

    await cache.ready();

    expect(storage.getItem(keysIndexKey)).toBeNull();
    expect(cache.get('test')).toBeUndefined();
  });

  it('throws a clear error when Storage is null or undefined', () => {
    expect(() => {
      new LocalStorageCachePersistenceAdapter(null as unknown as Storage);
    }).toThrow('LocalStorageCachePersistenceAdapter requires a valid Storage object');

    expect(() => {
      new LocalStorageCachePersistenceAdapter(undefined as unknown as Storage);
    }).toThrow('LocalStorageCachePersistenceAdapter requires a valid Storage object');
  });

  it('provides helpful guidance for SSR environments', () => {
    try {
      new LocalStorageCachePersistenceAdapter(null as unknown as Storage);
    } catch (e) {
      if (e instanceof Error) {
        expect(e.message).toContain('server-side rendering');
        expect(e.message).toContain('SSR');
        expect(e.message).toContain('MemoryCachePersistenceAdapter');
      }
    }
  });
});

describe('ReadCache Date round-tripping through persistence (issue #398)', () => {
  it('hydrates a persisted Date field back into a Date instance', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    const lastCheckin = new Date('2024-01-15T00:00:00.000Z');
    cache.set('will:1', { id: '1', lastCheckin }, ['1']);

    // Give the async persistence write a tick to land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const hydratedCache = new ReadCache({ persistence: adapter });
    await hydratedCache.ready();

    const hydrated = hydratedCache.get<{ id: string; lastCheckin: Date }>('will:1');
    expect(hydrated).toBeDefined();
    expect(hydrated!.lastCheckin).toBeInstanceOf(Date);
    expect(hydrated!.lastCheckin.getTime()).toBe(lastCheckin.getTime());
  });

  it('still round-trips bigint values alongside Date fields', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const cache = new ReadCache({ persistence: adapter });
    await cache.ready();

    const lastCheckin = new Date('2024-01-15T00:00:00.000Z');
    cache.set('will:1', { id: '1', balance: 123456789n, lastCheckin }, ['1']);

    await new Promise((resolve) => setTimeout(resolve, 0));

    const hydratedCache = new ReadCache({ persistence: adapter });
    await hydratedCache.ready();

    const hydrated = hydratedCache.get<{ id: string; balance: bigint; lastCheckin: Date }>('will:1');
    expect(hydrated!.balance).toBe(123456789n);
    expect(hydrated!.lastCheckin).toBeInstanceOf(Date);
  });
});

describe('MemoryCachePersistenceAdapter', () => {
  it('readAll returns empty array initially', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('write and readAll store and retrieve entries', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    const result = await adapter.readAll();

    expect(result).toContainEqual(entry);
  });

  it('write updates existing entry with same key', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry1: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe('"value2"');
  });

  it('delete removes entry', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    await adapter.delete('test:key');
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('clear removes all entries', async () => {
    const adapter = new MemoryCachePersistenceAdapter();
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.clear();
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });
});

describe.skipIf(!globalThis.indexedDB)('IndexedDbCachePersistenceAdapter', () => {
  let adapter: IndexedDbCachePersistenceAdapter;
  const dbName = `test-db-${Math.random()}`;
  const storeName = 'test-store';

  beforeEach(async () => {
    adapter = new IndexedDbCachePersistenceAdapter({
      dbName,
      storeName,
    });
  });

  afterEach(async () => {
    try {
      await adapter.clear();
    } catch {
      // Ignore cleanup errors
    }
    const deleteReq = indexedDB.deleteDatabase(dbName);
    await new Promise<void>((resolve) => {
      deleteReq.onsuccess = () => resolve();
      deleteReq.onerror = () => resolve();
    });
  });

  it('readAll returns empty array initially', async () => {
    const result = await adapter.readAll();
    expect(result).toEqual([]);
  });

  it('write and readAll store and retrieve entries', async () => {
    const entry: PersistedCacheEntry = {
      key: 'test:key',
      value: '"test value"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0]!).toEqual(entry);
  });

  it('write updates existing entry with same key', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'test:key',
      value: '"value2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0]!.value).toBe('"value2"');
  });

  it('delete removes specific entry', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.delete('key1');
    const result = await adapter.readAll();

    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('key2');
  });

  it('clear removes all entries', async () => {
    const entry1: PersistedCacheEntry = {
      key: 'key1',
      value: '"val1"',
      expiresAt: null,
      willIds: [],
    };
    const entry2: PersistedCacheEntry = {
      key: 'key2',
      value: '"val2"',
      expiresAt: null,
      willIds: [],
    };

    await adapter.write(entry1);
    await adapter.write(entry2);
    await adapter.clear();
    const result = await adapter.readAll();

    expect(result).toEqual([]);
  });

  it('handles multiple entries with bigint values', async () => {
    const entries: PersistedCacheEntry[] = [
      {
        key: 'key1',
        value: '{"__type":"bigint","value":"123456789"}',
        expiresAt: Date.now() + 60000,
        willIds: ['will1'],
      },
      {
        key: 'key2',
        value: '{"data":"test"}',
        expiresAt: null,
        willIds: ['will2', 'will3'],
      },
    ];

    for (const entry of entries) {
      await adapter.write(entry);
    }

    const result = await adapter.readAll();
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(entries[0]);
    expect(result).toContainEqual(entries[1]);
  });
});
