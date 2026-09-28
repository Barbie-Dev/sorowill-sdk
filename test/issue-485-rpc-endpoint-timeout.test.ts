import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RpcEndpointPool } from '../src/rpc';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

/**
 * Issue #485 — RpcEndpointPool does not fall back to secondary endpoints if
 * the primary endpoint hangs, blocking forever.
 *
 * Per-endpoint timeouts must be enforced. A slow/unresponsive endpoint should
 * be rotated to the back of the pool so that secondary endpoints are tried.
 */
describe('Issue #485 — RpcEndpointPool per-endpoint timeout and failover', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeMockServer(behaviour: 'hang' | 'fast' | 'error'): SoroWillRpcServer {
    return {
      getHealth: vi.fn(async () => {
        if (behaviour === 'hang') {
          // Never resolves — simulates an unresponsive primary endpoint
          return new Promise<never>(() => undefined);
        }
        if (behaviour === 'error') {
          throw new Error('fetch failed');
        }
        return { status: 'healthy' };
      }),
      simulateTransaction: vi.fn(),
      getAccount: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      pollTransaction: vi.fn(),
      getContractWasmByContractId: vi.fn(),
    } as unknown as SoroWillRpcServer;
  }

  it('falls back to the secondary endpoint when the primary hangs beyond endpointTimeoutMs', async () => {
    const primaryServer = makeMockServer('hang');
    const secondaryServer = makeMockServer('fast');

    // Alternate servers: index 0 → primary (hangs), index 1 → secondary (fast).
    let callIndex = 0;
    const serverOverride = {
      getHealth: vi.fn(async () => {
        const idx = callIndex++;
        if (idx === 0) {
          // Simulate primary hanging indefinitely
          return new Promise<never>(() => undefined);
        }
        return { status: 'healthy' };
      }),
    } as unknown as SoroWillRpcServer;

    // Use a very short timeout (50 ms) so the test runs quickly.
    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000, // failoverCooldownMs
      50,     // endpointTimeoutMs — short so the test is fast
    );

    const operationPromise = pool.withFailover((server) => (server as any).getHealth());

    // Advance fake timers past the per-endpoint timeout.
    await vi.advanceTimersByTimeAsync(100);

    const result = await operationPromise;
    expect(result).toEqual({ status: 'healthy' });
    // The hanging call was attempted once, then the secondary was called.
    expect(callIndex).toBe(2);
  });

  it('rotates the slow endpoint to the back of the pool after a timeout', async () => {
    let callIndex = 0;
    const serverOverride = {
      getHealth: vi.fn(async () => {
        const idx = callIndex++;
        if (idx === 0) {
          // Primary hangs on first call
          return new Promise<never>(() => undefined);
        }
        return { status: 'ok' };
      }),
    } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000,
      50,
    );

    const p = pool.withFailover((server) => (server as any).getHealth());
    await vi.advanceTimersByTimeAsync(100);
    await p;

    // After the failover the active URL should be the secondary.
    expect(pool.getActiveRpcUrl()).toBe('https://secondary.example');
  });

  it('surfaces the error when all endpoints time out', async () => {
    const serverOverride = {
      getHealth: vi.fn(async () => {
        return new Promise<never>(() => undefined);
      }),
    } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      serverOverride,
      60_000,
      50,
    );

    const p = pool.withFailover((server) => (server as any).getHealth());
    // Advance past both endpoint timeouts.
    await vi.advanceTimersByTimeAsync(200);
    await expect(p).rejects.toThrow(/timed out/i);
  });

  it('does not apply per-endpoint timeout when endpointTimeoutMs is 0 (disabled)', async () => {
    let resolved = false;
    let resolveFn: (() => void) | undefined;

    const serverOverride = {
      getHealth: vi.fn(async () => {
        return new Promise<string>((resolve) => {
          resolveFn = () => {
            resolved = true;
            resolve('ok');
          };
        });
      }),
    } as unknown as SoroWillRpcServer;

    // Disable timeout by passing 0
    const pool = new RpcEndpointPool(
      ['https://primary.example'],
      serverOverride,
      60_000,
      0,
    );

    const p = pool.withFailover((server) => (server as any).getHealth());

    // Even after a very long simulated wait, the operation should not have
    // been aborted because the timeout is disabled.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(resolved).toBe(false);

    // Resolve the pending operation manually.
    resolveFn?.();
    const result = await p;
    expect(result).toBe('ok');
  });

  it('promotes the primary endpoint again after the failover cooldown', async () => {
    let callIndex = 0;
    const serverOverride = {
      getHealth: vi.fn(async () => {
        callIndex++;
        return { status: 'ok' };
      }),
    } as unknown as SoroWillRpcServer;

    const pool = new RpcEndpointPool(
      ['https://primary.example', 'https://secondary.example'],
      {
        getHealth: vi.fn(async () => {
          const idx = callIndex++;
          if (idx === 0) return new Promise<never>(() => undefined);
          return { status: 'ok' };
        }),
      } as unknown as SoroWillRpcServer,
      100, // short failoverCooldownMs so we can test repromotion quickly
      50,
    );

    // First call — primary hangs, secondary takes over.
    const p = pool.withFailover((server) => (server as any).getHealth());
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(pool.getActiveRpcUrl()).toBe('https://secondary.example');

    // Advance past the failover cooldown.
    await vi.advanceTimersByTimeAsync(200);

    // After cooldown, the next call should re-promote the primary.
    const p2 = pool.withFailover((server) => (server as any).getHealth());
    await vi.advanceTimersByTimeAsync(50);
    await p2;
    expect(pool.getActiveRpcUrl()).toBe('https://primary.example');
  });
});
