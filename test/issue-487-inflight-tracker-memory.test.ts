import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { InFlightTracker } from '../src/inFlightTracker';

/**
 * Issue #487 — InFlightTracker accumulates transaction hashes indefinitely,
 * consuming unbounded memory for long-running applications.
 *
 * Acceptance criteria:
 * - Completed transactions removed from inFlightMap after confirmation
 *   (this was already done via .finally(); covered here to prevent regression)
 * - LRU/TTL-based cleanup implemented
 * - Map size stays constant over time in test
 */
describe('Issue #487 — InFlightTracker TTL and max-size cleanup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ─── Existing behaviour (regression guard) ────────────────────────────

  it('removes completed entries immediately via .finally()', async () => {
    const tracker = new InFlightTracker();
    const p = tracker.track('will-1', 'checkIn', async () => 'ok');
    expect(tracker.size).toBe(1);
    await p;
    expect(tracker.size).toBe(0);
  });

  it('removes failed entries immediately via .finally()', async () => {
    const tracker = new InFlightTracker();
    const p = tracker.track('will-1', 'checkIn', async () => {
      throw new Error('rpc error');
    });
    await p.catch(() => undefined);
    expect(tracker.size).toBe(0);
  });

  // ─── TTL-based eviction ───────────────────────────────────────────────

  it('evicts an entry lazily when TTL expires and isInFlight is checked', async () => {
    // 1 second TTL for testing
    const tracker = new InFlightTracker(1_000, 1_000);

    // Start an operation that never settles (simulates a stuck promise)
    tracker.track('will-stuck', 'checkIn', (_signal) => new Promise<string>(() => undefined));

    expect(tracker.isInFlight('will-stuck', 'checkIn')).toBe(true);
    expect(tracker.size).toBe(1);

    // Advance past TTL
    vi.advanceTimersByTime(2_000);

    // Lazy check removes it
    expect(tracker.isInFlight('will-stuck', 'checkIn')).toBe(false);
    expect(tracker.size).toBe(0);
  });

  it('getInFlightPromise returns undefined for TTL-expired entries', async () => {
    const tracker = new InFlightTracker(1_000, 500);

    tracker.track('will-1', 'checkIn', (_signal) => new Promise<string>(() => undefined));
    expect(tracker.getInFlightPromise('will-1', 'checkIn')).toBeDefined();

    vi.advanceTimersByTime(600);

    expect(tracker.getInFlightPromise('will-1', 'checkIn')).toBeUndefined();
  });

  it('starts a fresh operation if the previous entry has expired', async () => {
    const tracker = new InFlightTracker(1_000, 500);
    let callCount = 0;

    const makeOp = () =>
      tracker.track('will-1', 'checkIn', async (_signal) => {
        callCount++;
        return 'result';
      });

    // First call starts an operation that settles quickly
    await makeOp();
    expect(callCount).toBe(1);

    // Simulate time passing so a hypothetical stuck entry would expire
    vi.advanceTimersByTime(600);

    // Second call should start a new operation, not return the old promise
    await makeOp();
    expect(callCount).toBe(2);
  });

  // ─── Max-size cap (LRU-like eviction) ────────────────────────────────

  it('map size stays bounded when maxInFlight is reached', () => {
    const MAX = 5;
    const tracker = new InFlightTracker(MAX, 60_000);

    // Fill the map beyond capacity with stuck operations
    for (let i = 0; i < MAX + 10; i++) {
      tracker.track(`will-${i}`, 'checkIn', (_signal) => new Promise<string>(() => undefined));
    }

    // The tracker must never exceed MAX entries
    expect(tracker.size).toBeLessThanOrEqual(MAX);
  });

  it('evicts the oldest entry when max capacity is hit', () => {
    const tracker = new InFlightTracker(3, 60_000);

    // Add 3 stuck operations (fills the map)
    tracker.track('will-0', 'checkIn', (_signal) => new Promise<string>(() => undefined));
    tracker.track('will-1', 'checkIn', (_signal) => new Promise<string>(() => undefined));
    tracker.track('will-2', 'checkIn', (_signal) => new Promise<string>(() => undefined));

    expect(tracker.size).toBe(3);

    // Adding a 4th should evict will-0 (oldest)
    tracker.track('will-3', 'checkIn', (_signal) => new Promise<string>(() => undefined));

    expect(tracker.size).toBe(3);
    // The oldest entry (will-0) should have been evicted
    expect(tracker.isInFlight('will-0', 'checkIn')).toBe(false);
    // The newer entries should still be present
    expect(tracker.isInFlight('will-1', 'checkIn')).toBe(true);
    expect(tracker.isInFlight('will-2', 'checkIn')).toBe(true);
    expect(tracker.isInFlight('will-3', 'checkIn')).toBe(true);
  });

  it('size stays constant over many sequential transactions (no unbounded growth)', async () => {
    const tracker = new InFlightTracker(1_000, 60_000);

    // Simulate 200 transactions all completing normally
    for (let i = 0; i < 200; i++) {
      await tracker.track(`will-${i}`, 'checkIn', async () => `result-${i}`);
    }

    // After all transactions complete, the map should be empty
    expect(tracker.size).toBe(0);
  });

  // ─── pruneExpired via track() ─────────────────────────────────────────

  it('pruneExpired clears stale entries when new track() is called', () => {
    const tracker = new InFlightTracker(1_000, 100);

    // Add stuck operations
    tracker.track('will-stale-1', 'checkIn', (_signal) => new Promise<string>(() => undefined));
    tracker.track('will-stale-2', 'checkIn', (_signal) => new Promise<string>(() => undefined));
    expect(tracker.size).toBe(2);

    // Advance past TTL
    vi.advanceTimersByTime(200);

    // Adding a new entry triggers pruneExpired internally
    tracker.track('will-new', 'checkIn', (_signal) => new Promise<string>(() => undefined));

    // Stale entries should have been pruned; only the new one remains
    expect(tracker.size).toBe(1);
  });

  // ─── Aborted on eviction ─────────────────────────────────────────────

  it('aborts the controller when an entry is evicted by TTL', async () => {
    const tracker = new InFlightTracker(1_000, 100);
    let abortFired = false;

    tracker.track('will-1', 'checkIn', (signal) => {
      return new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => {
          abortFired = true;
          resolve('aborted');
        });
      });
    });

    vi.advanceTimersByTime(200);

    // Trigger lazy eviction via isInFlight
    tracker.isInFlight('will-1', 'checkIn');
    expect(abortFired).toBe(true);
  });
});
