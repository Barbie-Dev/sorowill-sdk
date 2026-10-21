import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ReadCache, type CachePersistenceAdapter } from '../src/cache';

function makePersistence(): CachePersistenceAdapter {
  const store = new Map<string, string>();
  return {
    read: async (key: string) => store.get(key) ?? null,
    write: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as CachePersistenceAdapter;
}

describe('#521 Cache TTL negative value handling', () => {
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  function spyOnWarn(): string[] {
    const calls: string[] = [];
    console.warn = ((...args: unknown[]) => {
      calls.push(args.map(String).join(' '));
    }) as typeof console.warn;
    return calls;
  }

  it('accepts a zero ttlMs without warning', () => {
    const calls = spyOnWarn();
    expect(() => new ReadCache({ persistence: makePersistence(), ttlMs: 0 })).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('accepts a positive ttlMs without warning', () => {
    const calls = spyOnWarn();
    expect(() => new ReadCache({ persistence: makePersistence(), ttlMs: 5000 })).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('logs a warning and treats negative ttlMs as 0', () => {
    const calls = spyOnWarn();
    const cache = new ReadCache({ persistence: makePersistence(), ttlMs: -1000 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('negative ttlMs');
    expect(calls[0]).toContain('-1000');
    // With ttlMs treated as 0, entries expire immediately.
    cache.set('key', 'value');
    expect(cache.get('key')).toBeUndefined();
  });

  it('logs a warning and treats very negative ttlMs as 0', () => {
    const calls = spyOnWarn();
    const cache = new ReadCache({ persistence: makePersistence(), ttlMs: -999999 });
    expect(calls).toHaveLength(1);
    expect(cache.get('anything')).toBeUndefined();
  });

  it('still throws for non-numeric ttlMs', () => {
    expect(() => new ReadCache({ ttlMs: NaN as unknown as number })).toThrow(
      /ttlMs/,
    );
  });

  it('still throws for Infinity ttlMs', () => {
    expect(() => new ReadCache({ ttlMs: Infinity })).toThrow(/ttlMs/);
  });

  it('still throws for -Infinity ttlMs', () => {
    expect(() => new ReadCache({ ttlMs: -Infinity })).toThrow(/ttlMs/);
  });
});