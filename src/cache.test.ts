import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createReadCacheKey,
  ReadCache,
  type CachePersistenceAdapter,
} from './cache';

describe('createReadCacheKey', () => {
  it('produces identical keys regardless of runtime locale', () => {
    const args = { Z: 1, a: 2, 'é': 3, A: 4 };

    const originalLocale = Intl.DateTimeFormat().resolvedOptions().locale;
    const originalLocaleCompare = String.prototype.localeCompare;

    try {
      const keyDefault = createReadCacheKey('read', args);

      // Simulate a different runtime locale by making localeCompare behave
      // differently; a locale-independent sort must be unaffected.
      String.prototype.localeCompare = function (
        this: string,
        that: string,
      ): number {
        // Reverse-ish ordering to expose locale-dependent sorting.
        return that < this ? -1 : that > this ? 1 : 0;
      };

      const keyOtherLocale = createReadCacheKey('read', args);

      expect(keyOtherLocale).toBe(keyDefault);
    } finally {
      String.prototype.localeCompare = originalLocaleCompare;
      void originalLocale;
    }
  });

  it('sorts keys with a locale-independent code-unit comparison', () => {
    const key = createReadCacheKey('read', { b: 1, A: 2, a: 3, B: 4 });
    // Code-unit order: 'A' (65) < 'B' (66) < 'a' (97) < 'b' (98)
    expect(key).toBe('read:{"A":2,"B":4,"a":3,"b":1}');
  });

  it('handles accented and capital letters deterministically', () => {
    const args = { 'é': 1, Z: 2, a: 3 };
    const first = createReadCacheKey('read', args);
    const second = createReadCacheKey('read', { a: 3, Z: 2, 'é': 1 });
    expect(first).toBe(second);
  });
});

describe('ReadCache', () => {
  let adapter: CachePersistenceAdapter;
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    adapter = {
      read: vi.fn(async (key: string) => store.get(key) ?? null),
      write: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached values for identical arguments', async () => {
    const cache = new ReadCache(adapter);
    const loader = vi.fn(async () => 'value');

    await cache.get('read', { a: 1, b: 2 }, loader);
    const second = await cache.get('read', { b: 2, a: 1 }, loader);

    expect(second).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  describe('ttlMs validation', () => {
    it('accepts a finite non-negative ttlMs', () => {
      expect(() => new ReadCache(adapter, { ttlMs: 0 })).not.toThrow();
      expect(() => new ReadCache(adapter, { ttlMs: 1000 })).not.toThrow();
    });

    it('throws for a negative ttlMs', () => {
      expect(() => new ReadCache(adapter, { ttlMs: -1 })).toThrow(
        /ttlMs/,
      );
    });

    it('throws for NaN ttlMs', () => {
      expect(() => new ReadCache(adapter, { ttlMs: Number.NaN })).toThrow(
        /ttlMs/,
      );
    });

    it('throws for Infinity ttlMs', () => {
      expect(() => new ReadCache(adapter, { ttlMs: Number.POSITIVE_INFINITY })).toThrow(
        /ttlMs/,
      );
    });

    it('throws for -Infinity ttlMs', () => {
      expect(() => new ReadCache(adapter, { ttlMs: Number.NEGATIVE_INFINITY })).toThrow(
        /ttlMs/,
      );
    });
  });
});
