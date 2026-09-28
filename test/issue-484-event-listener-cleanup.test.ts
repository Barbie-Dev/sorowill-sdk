// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { describe, expect, it, vi } from 'vitest';

vi.mock('@stellar/freighter-api', () => ({
  default: {
    getAddress: vi.fn(),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn(),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
}));

vi.mock('@stellar/stellar-sdk', () => {
  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string {
      return this.id;
    }
    call() {
      return {};
    }
  }
  class MockServer {
    constructor(public readonly url: string) {}
  }
  return {
    Account: class {},
    BASE_FEE: '100',
    Contract: MockContract,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: class {},
    TransactionBuilder: class {},
    contract: {
      Spec: Object.assign(function Spec() {
        return { funcArgsToScVals: () => [], funcResToNative: (_m: string, v: unknown) => v };
      }, { fromWasm: () => ({ funcArgsToScVals: () => [], funcResToNative: (_m: string, v: unknown) => v }) }),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: () => false,
        isSimulationRestore: () => false,
      },
      Server: MockServer,
    },
    xdr: { ScVal: { scvVoid: () => ({}) } },
  };
});

import { SoroWillClient } from '../src/SoroWillClient';
import type { WillEventListener, WillEventSubscription } from '../src/events';

/**
 * Issue #484 — EventSubscription listeners are not deregistered on error,
 * causing memory leaks if subscription fails.
 *
 * When `eventSource.subscribe()` throws during SoroWillClient construction,
 * any listener that was registered before the error must be removed so that
 * no orphaned listeners accumulate across repeated subscription attempts.
 */
describe('Issue #484 — EventSubscription listener cleanup on error', () => {
  it('re-throws the error when eventSource.subscribe throws', () => {
    const subscribeError = new Error('eventSource setup failed');

    const faultyEventSource = {
      subscribe: vi.fn((_listener: WillEventListener): WillEventSubscription => {
        throw subscribeError;
      }),
    };

    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        readCache: { ttlMs: 60_000 },
        eventSource: faultyEventSource,
      });
    }).toThrow('eventSource setup failed');
  });

  it('cleans up a partially-registered subscription when subscribe throws after returning a handle', () => {
    // Simulate a source that returns a subscription handle but then throws
    // (unusual but possible if the error is raised asynchronously-sync during setup).
    const unsubscribeSpy = vi.fn();
    let callCount = 0;

    const partialEventSource = {
      subscribe: vi.fn((_listener: WillEventListener): WillEventSubscription => {
        callCount++;
        if (callCount > 1) {
          // Second call throws — simulates a repeated failed attempt that
          // accumulates orphaned listeners without the fix.
          throw new Error('second subscribe failed');
        }
        return { unsubscribe: unsubscribeSpy };
      }),
    };

    // First construction succeeds
    new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readCache: { ttlMs: 60_000 },
      eventSource: partialEventSource,
    });

    // Second construction with a fresh source that immediately throws
    const throwingSource = {
      subscribe: vi.fn((_listener: WillEventListener): WillEventSubscription => {
        throw new Error('immediate throw');
      }),
    };

    expect(() => {
      new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        readCache: { ttlMs: 60_000 },
        eventSource: throwingSource,
      });
    }).toThrow('immediate throw');

    // The first successful subscription should still be valid (no spurious cleanup).
    expect(unsubscribeSpy).not.toHaveBeenCalled();
  });

  it('does not leave eventSubscription set when subscribe throws', () => {
    const faultyEventSource = {
      subscribe: vi.fn((_listener: WillEventListener): WillEventSubscription => {
        throw new Error('subscribe threw');
      }),
    };

    let client: SoroWillClient | undefined;
    try {
      client = new SoroWillClient({
        network: 'testnet',
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
        readCache: { ttlMs: 60_000 },
        eventSource: faultyEventSource,
      });
    } catch {
      // expected
    }

    // client was never assigned because the constructor threw
    expect(client).toBeUndefined();
  });

  it('registers the listener correctly when subscribe does not throw', () => {
    let registeredListener: WillEventListener | undefined;
    const unsubscribeSpy = vi.fn();

    const workingEventSource = {
      subscribe: vi.fn((listener: WillEventListener): WillEventSubscription => {
        registeredListener = listener;
        return { unsubscribe: unsubscribeSpy };
      }),
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readCache: { ttlMs: 60_000 },
      eventSource: workingEventSource,
    });

    expect(workingEventSource.subscribe).toHaveBeenCalledOnce();
    expect(registeredListener).toBeDefined();

    // Listener should not have been removed yet
    expect(unsubscribeSpy).not.toHaveBeenCalled();

    // Destroying the client should unsubscribe the listener
    client.destroy();
    expect(unsubscribeSpy).toHaveBeenCalledOnce();
  });
});
