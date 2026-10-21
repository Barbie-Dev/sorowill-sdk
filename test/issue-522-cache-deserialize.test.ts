import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { deserializeCacheValue } from '../src/cache';

describe('#522 deserializeCacheValue type validation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('deserializes a known __type: "bigint" value correctly', () => {
    const json = JSON.stringify({ __type: 'bigint', value: '12345678901234567890' });
    const result = deserializeCacheValue<bigint>(json);
    expect(result).toBe(12345678901234567890n);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('deserializes a known __type: "date" value correctly', () => {
    const iso = '2024-01-15T10:30:00.000Z';
    const json = JSON.stringify({ __type: 'date', value: iso });
    const result = deserializeCacheValue<Date>(json);
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe(iso);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs a warning for an unknown __type and returns the raw object', () => {
    const json = JSON.stringify({ __type: 'unknown_type', value: 'some-value' });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({ __type: 'unknown_type', value: 'some-value' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain('unknown_type');
  });

  it('logs a warning for a malformed __type object missing value', () => {
    const json = JSON.stringify({ __type: 'bigint' });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({ __type: 'bigint' });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('passes through plain values without __type unchanged', () => {
    const json = JSON.stringify({ name: 'test', count: 42 });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({ name: 'test', count: 42 });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('handles nested objects with unknown __type gracefully', () => {
    const json = JSON.stringify({
      outer: { __type: 'bogus', value: 'x' },
      inner: { __type: 'bigint', value: '42' },
    });
    const result = deserializeCacheValue(json);
    expect(result).toEqual({
      outer: { __type: 'bogus', value: 'x' },
      inner: 42n,
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});