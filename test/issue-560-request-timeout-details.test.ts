import { describe, expect, it } from 'vitest';
import { RequestTimeoutError } from '../src/errors';
import { RequestQueue } from '../src/requestQueue';
import { SoroWillClient } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

describe('Issue #560: RequestTimeoutError request details for debugging', () => {
  it('includes operation name in message and properties when method is supplied', () => {
    const error = new RequestTimeoutError(5000, 'get_will');

    expect(error.timeoutMs).toBe(5000);
    expect(error.method).toBe('get_will');
    expect(error.operation).toBe('get_will');
    expect(error.message).toContain('get_will');
    expect(error.message).toContain('5000');
    expect(error.name).toBe('RequestTimeoutError');
  });

  it('maintains backwards compatibility when method is omitted', () => {
    const error = new RequestTimeoutError(3000);

    expect(error.timeoutMs).toBe(3000);
    expect(error.method).toBeUndefined();
    expect(error.operation).toBeUndefined();
    expect(error.message).toBe('SoroWill RPC request timed out after 3000ms');
  });

  it('maintains backwards compatibility when ErrorOptions is passed as second argument', () => {
    const cause = new Error('underlying connection reset');
    const error = new RequestTimeoutError(4000, { cause });

    expect(error.timeoutMs).toBe(4000);
    expect(error.method).toBeUndefined();
    expect(error.cause).toBe(cause);
    expect(error.message).toBe('SoroWill RPC request timed out after 4000ms');
  });

  it('accepts both method and ErrorOptions', () => {
    const cause = new Error('network down');
    const error = new RequestTimeoutError(1500, 'simulateTransaction', { cause });

    expect(error.timeoutMs).toBe(1500);
    expect(error.method).toBe('simulateTransaction');
    expect(error.operation).toBe('simulateTransaction');
    expect(error.cause).toBe(cause);
    expect(error.message).toContain('simulateTransaction');
  });

  it('RequestQueue includes method name in RequestTimeoutError upon timeout', async () => {
    const queue = new RequestQueue();
    const timeoutMs = 20;

    await expect(
      queue.enqueue(
        () => new Promise(() => {}), // never resolves
        timeoutMs,
        undefined,
        undefined,
        'getAccount',
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RequestTimeoutError);
      const timeoutErr = err as RequestTimeoutError;
      expect(timeoutErr.method).toBe('getAccount');
      expect(timeoutErr.operation).toBe('getAccount');
      expect(timeoutErr.message).toContain('getAccount');
      return true;
    });
  });

  it('SoroWillClient propagates operation name in RequestTimeoutError from reads', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readCache: false,
      retry: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0 },
      timeoutMs: 15,
      spec: {
        funcArgsToScVals: () => [],
        funcResToNative: () => ({}),
      } as any,
      rpcServer: {
        getContractWasmByContractId: async () => new Uint8Array(),
        simulateTransaction: () => new Promise(() => {}), // hangs
      } as unknown as SoroWillRpcServer,
    });

    await expect(client.getWill('1')).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(RequestTimeoutError);
      const timeoutErr = err as RequestTimeoutError;
      expect(timeoutErr.method).toBe('get_will');
      expect(timeoutErr.operation).toBe('get_will');
      expect(timeoutErr.message).toContain('get_will');
      return true;
    });
  });
});
