// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { freighterApiMock, mockState } = vi.hoisted(() => ({
  freighterApiMock: {
    getAddress: vi.fn(async () => ({ address: 'GTESTACCOUNT', error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn().mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'TESTNET' }),
    isConnected: vi.fn(),
    signTransaction: vi.fn(),
  },
  mockState: {
    createdServerUrls: [] as string[],
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    pollTransaction: vi.fn(async () => ({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: 42n,
    })),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
    sendTransaction: vi.fn(async () => ({ hash: () => 'TX_HASH' })),
    simulateTransaction: vi.fn(async () => ({
      error: undefined,
      results: [{ auth: [], xdr: '' }],
      minResourceFee: '1000',
      restorePreamble: undefined,
    })),
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

vi.mock('@stellar/stellar-sdk', async () => {
  const { StrKey } = await vi.importActual<typeof import('@stellar/stellar-sdk')>(
    '@stellar/stellar-sdk',
  );

  class MockAccount {
    constructor(
      public readonly accountId: string,
      public readonly sequence: string,
    ) {}

    incrementSequenceNumber(): void {
      // Mock implementation
    }
  }

  class MockContract {
    constructor(private readonly id: string) {}

    contractId(): string {
      return this.id;
    }

    call(method: string, ...args: unknown[]): { contractId: string; method: string; args: unknown[] } {
      return { contractId: this.id, method, args };
    }
  }

  class MockServer {
    constructor(public readonly url: string) {
      mockState.createdServerUrls.push(url);
    }

    getAccount = mockState.getAccount;
    getContractWasmByContractId = mockState.getContractWasmByContractId;
    pollTransaction = mockState.pollTransaction;
    prepareTransaction = mockState.prepareTransaction;
    sendTransaction = mockState.sendTransaction;
    simulateTransaction = mockState.simulateTransaction;
  }

  class MockTransactionBuilder {
    private operation: unknown;

    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}

    addOperation(operation: unknown): this {
      this.operation = operation;
      return this;
    }

    setTimeout(_timeout: number): this {
      return this;
    }

    build(): {
      source: string;
      fee: string;
      networkPassphrase: string;
      operation: unknown;
      toXDR: () => string;
    } {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }

    static fromXDR(_xdr: string, _networkPassphrase: string): unknown {
      return new MockTransaction();
    }
  }

  class MockTransaction {
    toXDR(): string {
      return 'TX_XDR';
    }
  }

  class MockFeeBumpTransaction {}

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: {
      PUBLIC: 'PUBLIC',
      TESTNET: 'TESTNET',
    },
    Transaction: MockTransaction,
    FeeBumpTransaction: MockFeeBumpTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_entries?: unknown) {
          return {
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          };
        },
        {
          fromWasm: () => ({
            funcArgsToScVals: (_method: string, args: Record<string, unknown>) => [args],
            funcResToNative: (_method: string, value: unknown) => value,
          }),
        },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: {
          SUCCESS: 'SUCCESS',
        },
        isSimulationError: (simulation: { error?: string }) => Boolean(simulation.error),
        isSimulationRestore: () => false,
      },
      Server: MockServer,
    },
    xdr: {
      ScVal: {
        scvVoid: () => ({}),
      },
      Operation: {},
      TransactionEnvelope: {
        fromXDR: () => ({
          switch: () => ({}),
          v1: () => ({
            tx: () => ({
              operations: [],
            }),
          }),
        }),
      },
    },
  };
});

import { SoroWillClient } from '../src/SoroWillClient';
import { HookManager } from '../src/hooks';

describe('Issue #213: Throwing afterInvoke hook on success path makes invoke() report failure', () => {
  let client: SoroWillClient;
  let hookManager: HookManager;
  let afterInvokeCallCount = 0;

  beforeEach(() => {
    vi.clearAllMocks();
    afterInvokeCallCount = 0;
    mockState.createdServerUrls = [];

    hookManager = new HookManager();
    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'TESTCONTRACT',
      hooks: hookManager,
    });
  });

  it('should not throw when afterInvoke hook throws on success path', async () => {
    const throwingHook = vi.fn(async () => {
      throw new Error('Hook failed: analytics unavailable');
    });

    hookManager.onAfterInvoke(throwingHook);

    freighterApiMock.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      error: undefined,
    });

    // Mock that the return value is present
    mockState.simulateTransaction.mockResolvedValue({
      error: undefined,
      results: [{ auth: [], xdr: 'RESULT_XDR' }],
      minResourceFee: '1000',
      restorePreamble: undefined,
    });

    let thrownError: Error | null = null;
    let result = null;
    try {
      result = await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
        checkinPeriodDays: 30,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      thrownError = err instanceof Error ? err : new Error(String(err));
    }

    expect(thrownError).toBeNull();
    expect(result).toBeDefined();
    expect(result?.txHash).toBeTruthy();
  });

  it('should not dispatch afterInvoke hooks twice for the same invocation', async () => {
    const countingHook = vi.fn(async () => {
      afterInvokeCallCount++;
    });

    hookManager.onAfterInvoke(countingHook);

    freighterApiMock.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      error: undefined,
    });

    await client.createWill({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      amount: '1000000',
      beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
      checkinPeriodDays: 30,
      gracePeriodDays: 7,
      guardians: [],
    });

    expect(countingHook).toHaveBeenCalledTimes(1);
    expect(afterInvokeCallCount).toBe(1);
  });

  it('should call afterInvoke with success context when transaction succeeds', async () => {
    const hookSpy = vi.fn();
    hookManager.onAfterInvoke(hookSpy);

    freighterApiMock.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      error: undefined,
    });

    await client.createWill({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      amount: '1000000',
      beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
      checkinPeriodDays: 30,
      gracePeriodDays: 7,
      guardians: [],
    });

    expect(hookSpy).toHaveBeenCalledTimes(1);
    const callContext = hookSpy.mock.calls[0][0];
    expect(callContext.method).toBe('create_will');
    expect(callContext.txHash).toBeTruthy();
    expect(callContext.error).toBeNull();
  });

  it('should prevent throwing afterInvoke hook from being converted to transaction failure', async () => {
    const throwingHook = vi.fn(async () => {
      throw new Error('Instrumentation failed');
    });

    hookManager.onAfterInvoke(throwingHook);

    freighterApiMock.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      error: undefined,
    });

    const result = await client.createWill({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      amount: '1000000',
      beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
      checkinPeriodDays: 30,
      gracePeriodDays: 7,
      guardians: [],
    });

    expect(result).toBeDefined();
    expect(result.txHash).toBeTruthy();
  });

  it('should not dispatch afterInvoke a second time when first hook throws', async () => {
    const firstHook = vi.fn(async () => {
      throw new Error('First hook fails');
    });
    const secondHook = vi.fn();

    hookManager.onAfterInvoke(firstHook);
    hookManager.onAfterInvoke(secondHook);

    freighterApiMock.signTransaction.mockResolvedValue({
      signedXDR: 'SIGNED_XDR',
      error: undefined,
    });

    await client.createWill({
      token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
      amount: '1000000',
      beneficiaries: [{ address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 }],
      checkinPeriodDays: 30,
      gracePeriodDays: 7,
      guardians: [],
    });

    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
  });
});
