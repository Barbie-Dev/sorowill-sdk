/**
 * Tests for issue #533: RpcEndpointPool doesn't implement exponential backoff
 * for failing endpoints — a failing endpoint was retried immediately on the
 * next request, wasting requests while it was still unhealthy.
 *
 * Acceptance criteria:
 * - Exponential backoff implemented (base * 2^(consecutiveFailures - 1),
 *   capped at a maximum)
 * - Failing endpoints are deprioritized while their backoff window lasts
 * - Test verifies the backoff
 *
 * The pool's backoff decisions are time-based, so these tests fake only the
 * `Date` global (via `vi.useFakeTimers({ toFake: ['Date'] })`) and drive time
 * forward with `vi.setSystemTime` instead of sleeping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RpcEndpointPool } from '../src/rpc';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

const PRIMARY = 'https://primary.example';
const SECONDARY = 'https://secondary.example';
const UNUSED_SERVER = {} as SoroWillRpcServer;

interface HarnessOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  failoverCooldownMs?: number;
}

/**
 * Builds a pool over PRIMARY/SECONDARY plus an operation that records which
 * URLs were hit and fails for any URL present in `failing`.
 */
function makeHarness(failing: Set<string>, options: HarnessOptions = {}) {
  const {
    backoffBaseMs = 1_000,
    backoffMaxMs = 8_000,
    failoverCooldownMs = 60_000,
  } = options;
  const calls: string[] = [];
  const pool = new RpcEndpointPool(
    [PRIMARY, SECONDARY],
    UNUSED_SERVER,
    failoverCooldownMs,
    0,      // timeout disabled — these tests exercise endpoint backoff, not timeouts
    1,      // timeoutMaxAttempts
    1_000,  // timeoutRetryBaseDelayMs
    backoffBaseMs,
    backoffMaxMs,
  );
  const operation = async (_server: SoroWillRpcServer, rpcUrl: string): Promise<string> => {
    calls.push(rpcUrl);
    if (failing.has(rpcUrl)) {
      throw new Error('fetch failed');
    }
    return `ok:${rpcUrl}`;
  };
  return { pool, operation, calls };
}

describe('RpcEndpointPool — issue #533: exponential backoff for failing endpoints', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deprioritizes a failing endpoint instead of retrying it immediately', async () => {
    const failing = new Set([PRIMARY]);
    // Short failover cooldown so the pool would normally re-promote the
    // primary quickly — the backoff must still keep traffic off it.
    const { pool, operation, calls } = makeHarness(failing, {
      backoffBaseMs: 1_000,
      failoverCooldownMs: 100,
    });
    const t0 = Date.now();

    // First request: primary fails, failover succeeds on secondary.
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // At t0 + 150 the failover cooldown has elapsed, so the pool re-promotes
    // the primary — but its backoff window (until t0 + 1000) is still open,
    // so the request must be routed to the secondary instead of immediately
    // retrying the failing primary.
    vi.setSystemTime(t0 + 150);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([SECONDARY]);
  });

  it('retries the endpoint once its backoff window has elapsed', async () => {
    const failing = new Set([PRIMARY]);
    const { pool, operation, calls } = makeHarness(failing, {
      backoffBaseMs: 1_000,
      failoverCooldownMs: 100,
    });
    const t0 = Date.now();

    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // At t0 + 1100 the first backoff window (base = 1000ms) has elapsed, so
    // the primary is retried first, fails again, and the secondary takes over.
    vi.setSystemTime(t0 + 1_100);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);
  });

  it('doubles the backoff window for every consecutive failure', async () => {
    const failing = new Set([PRIMARY]);
    const { pool, operation, calls } = makeHarness(failing, { backoffBaseMs: 1_000 });
    const t0 = Date.now();

    // Failure 1 on the primary at t0 → it backs off until t0 + 1000.
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // At t0 + 1100 the secondary now fails too; the failover lands back on
    // the primary (its first window elapsed) which fails a second time →
    // its window is now the doubled 2000ms, until t0 + 3100.
    vi.setSystemTime(t0 + 1_100);
    failing.add(SECONDARY);
    calls.length = 0;
    await expect(pool.withFailover(operation)).rejects.toThrow('fetch failed');
    expect(calls).toEqual([SECONDARY, PRIMARY]);

    // At t0 + 2200: the secondary's window (until t0 + 2100) has elapsed but
    // the primary's doubled window (until t0 + 3100) has not — the primary
    // must be skipped.
    vi.setSystemTime(t0 + 2_200);
    failing.delete(SECONDARY);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([SECONDARY]);

    // At t0 + 3200 the doubled window has elapsed and the primary is retried.
    vi.setSystemTime(t0 + 3_200);
    failing.delete(PRIMARY);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${PRIMARY}`);
    expect(calls).toEqual([PRIMARY]);
  });

  it('caps the backoff window at endpointBackoffMaxMs', async () => {
    const failing = new Set([PRIMARY]);
    // base = 1000, cap = 1500: the second failure would double the window to
    // 2000ms but is capped at 1500ms.
    const { pool, operation, calls } = makeHarness(failing, {
      backoffBaseMs: 1_000,
      backoffMaxMs: 1_500,
      failoverCooldownMs: 100,
    });
    const t0 = Date.now();

    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`); // failure 1
    vi.setSystemTime(t0 + 1_100);
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`); // failure 2, capped until t0 + 2600
    expect(calls).toEqual([PRIMARY, SECONDARY, PRIMARY, SECONDARY]);

    // t0 + 2700: past the capped window (t0 + 2600) but well inside the
    // uncapped doubling window (t0 + 3100) — only the cap makes the primary
    // eligible again here.
    vi.setSystemTime(t0 + 2_700);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);
  });

  it('resets the backoff after a successful request to the endpoint', async () => {
    const failing = new Set([PRIMARY]);
    const { pool, operation, calls } = makeHarness(failing, {
      backoffBaseMs: 1_000,
      failoverCooldownMs: 100,
    });
    const t0 = Date.now();

    // Failure 1 on the primary at t0 → window [t0, t0 + 1000].
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // At t0 + 1100 the primary succeeds → its backoff state is cleared.
    vi.setSystemTime(t0 + 1_100);
    failing.delete(PRIMARY);
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${PRIMARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY, PRIMARY]);

    // Fail again immediately: with the counter reset, the new window is the
    // base 1000ms (until t0 + 2100) — not the doubled 2000ms (t0 + 3100).
    failing.add(PRIMARY);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // At t0 + 2200 the base window has elapsed, so the primary is retried
    // (it would still be skipped had the failure count not been reset).
    vi.setSystemTime(t0 + 2_200);
    calls.length = 0;
    await expect(pool.withFailover(operation)).resolves.toBe(`ok:${SECONDARY}`);
    expect(calls).toEqual([PRIMARY, SECONDARY]);
  });

  it('still attempts an endpoint when every endpoint is backing off (no permanent stall)', async () => {
    const failing = new Set([PRIMARY, SECONDARY]);
    const { pool, operation, calls } = makeHarness(failing);

    // Both endpoints fail → the request surfaces the last error.
    await expect(pool.withFailover(operation)).rejects.toThrow('fetch failed');
    expect(calls).toEqual([PRIMARY, SECONDARY]);

    // Both endpoints are now backing off, but the pool must still retry
    // something rather than dropping the request on the floor.
    calls.length = 0;
    await expect(pool.withFailover(operation)).rejects.toThrow('fetch failed');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('does not deprioritize endpoints for non-connection (application) errors', async () => {
    const calls: string[] = [];
    const pool = new RpcEndpointPool(
      [PRIMARY, SECONDARY],
      UNUSED_SERVER,
      60_000,
      0,
      1,
      1_000,
      1_000,
      8_000,
    );
    const operation = async (_server: SoroWillRpcServer, rpcUrl: string): Promise<string> => {
      calls.push(rpcUrl);
      // Not a retryable connection error — says nothing about endpoint health.
      throw new Error('invalid contract id');
    };

    await expect(pool.withFailover(operation)).rejects.toThrow('invalid contract id');
    expect(calls).toEqual([PRIMARY]);

    // No backoff was recorded, so the primary is tried again immediately.
    calls.length = 0;
    await expect(pool.withFailover(operation)).rejects.toThrow('invalid contract id');
    expect(calls).toEqual([PRIMARY]);
  });
});
