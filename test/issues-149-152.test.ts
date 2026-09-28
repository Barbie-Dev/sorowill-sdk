// @ts-nocheck -- mock SDK types are fundamentally incompatible with real @stellar/stellar-sdk types
/**
 * Unit tests for issues #149, #150, and #152:
 *
 * #149 – createWill validates checkinPeriodDays / gracePeriodDays as positive
 *        integers before passing them to BigInt().
 * #150 – invoke() failure branches attach RPC diagnostic fields to the thrown
 *        error instead of discarding them.
 * #152 – submit() catches getAccount() failures and rethrows them as a clear
 *        AccountNotFundedError rather than leaking the raw RPC error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist shared mock state so vi.mock() factory closures can reference it.
// ---------------------------------------------------------------------------

const { mockState } = vi.hoisted(() => ({
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
    sendTransaction: vi.fn(async () => ({
      status: 'PENDING',
      hash: 'TX_HASH_123',
    })),
    simulateTransaction: vi.fn(),
    walletPublicKey: 'GTESTACCOUNT',
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  default: {
    getAddress: vi.fn(async () => ({ address: mockState.walletPublicKey, error: undefined })),
    requestAccess: vi.fn(),
    getNetworkDetails: vi.fn().mockResolvedValue({ network: 'TESTNET', networkPassphrase: 'Test SDF Network ; September 2015' }),
    isConnected: vi.fn(),
    signTransaction: vi.fn(async (xdr: string) => xdr),
  },
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
  }

  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string { return this.id; }
    call(method: string, ...args: unknown[]) {
      return { contractId: this.id, method, args };
    }
  }

  class MockTransaction {
    constructor(private readonly xdr: string = 'TX_XDR') {}
    toXDR(): string { return this.xdr; }
  }

  class MockTransactionBuilder {
    private ops: unknown[] = [];
    constructor(
      private readonly account: MockAccount,
      private readonly options: { fee: string; networkPassphrase: string },
    ) {}
    addOperation(op: unknown): this { this.ops.push(op); return this; }
    setTimeout(_t: number): this { return this; }
    build() {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        ops: this.ops,
        toXDR: () => 'TX_XDR',
      };
    }
    static fromXDR(xdr: string, _np: string) { return new MockTransaction(xdr); }
  }

  class MockServer {
    constructor(public readonly url: string) {
      mockState.createdServerUrls.push(url);
    }
    get getAccount() { return mockState.getAccount; }
    get getContractWasmByContractId() { return mockState.getContractWasmByContractId; }
    get pollTransaction() { return mockState.pollTransaction; }
    get prepareTransaction() { return mockState.prepareTransaction; }
    get sendTransaction() { return mockState.sendTransaction; }
    get simulateTransaction() { return mockState.simulateTransaction; }
  }

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'Test SDF Network ; September 2015' },
    Transaction: MockTransaction,
    TransactionBuilder: MockTransactionBuilder,
    contract: {
      Spec: Object.assign(
        function Spec(_e?: unknown) {
          return {
            funcArgsToScVals: (_m: string, a: Record<string, unknown>) => [a],
            funcResToNative: (_m: string, v: unknown) => v,
          };
        },
        {
          fromWasm: () => ({
            funcArgsToScVals: (_m: string, a: Record<string, unknown>) => [a],
            funcResToNative: (_m: string, v: unknown) => {
              // create_will returns the will id as a bigint
              if (typeof v === 'bigint') return v;
              return v;
            },
          }),
        },
      ),
    },
    rpc: {
      Api: {
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (s: { error?: string }) => Boolean(s.error),
        isSimulationRestore: () => false,
      },
      Server: MockServer,
    },
    xdr: {
      ScVal: { scvVoid: () => ({}) },
      Operation: {},
      TransactionEnvelope: {
        fromXDR: () => ({
          switch: () => ({}),
          v1: () => ({ tx: () => ({ operations: () => [] }) }),
          toXDR: () => ({ toString: () => '' }),
        }),
      },
      EnvelopeType: {
        envelopeTypeTx: () => ({}),
        envelopeTypeTxFeeBump: () => ({}),
      },
      DecoratedSignature: { fromXDR: () => ({}) },
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { SoroWillClient } from '../src/SoroWillClient';
import {
  AccountNotFundedError,
  InvokeFailedError,
  SoroWillError,
} from '../src/errors';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: { rpcServer?: unknown } = {}): SoroWillClient {
  return new SoroWillClient({
    network: 'testnet',
    contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAARRDD',
    ...(overrides.rpcServer ? { rpcServer: overrides.rpcServer as never } : {}),
  });
}

const VALID_BENEFICIARIES = [
  { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
];

// ---------------------------------------------------------------------------
// #149 — createWill validates checkinPeriodDays / gracePeriodDays
// ---------------------------------------------------------------------------

describe('#149 – createWill day-param validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default successful path
    mockState.getAccount.mockResolvedValue({ accountId: 'GTESTACCOUNT', sequence: '1' });
    mockState.prepareTransaction.mockImplementation(async (tx: { toXDR: () => string }) => ({
      toXDR: tx.toXDR,
    }));
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: 1n,
    });
  });

  it('throws SoroWillError (not a RangeError) when checkinPeriodDays is fractional', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90.5,   // non-integer
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(SoroWillError);
  });

  it('error message names the offending parameter "checkinPeriodDays"', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90.5,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(/checkinPeriodDays/);
  });

  it('does NOT throw the native RangeError from BigInt()', async () => {
    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90.5,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }
    // Must be SoroWillError, not the raw RangeError BigInt() would throw.
    expect(caught).toBeInstanceOf(SoroWillError);
    expect(caught).not.toBeInstanceOf(RangeError);
  });

  it('throws SoroWillError when gracePeriodDays is fractional', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7.5,   // non-integer
        guardians: [],
      }),
    ).rejects.toThrow(SoroWillError);
  });

  it('error message names the offending parameter "gracePeriodDays"', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7.5,
        guardians: [],
      }),
    ).rejects.toThrow(/gracePeriodDays/);
  });

  it('throws when checkinPeriodDays is zero', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 0,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(SoroWillError);
  });

  it('throws when checkinPeriodDays is negative', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: -1,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(SoroWillError);
  });

  it('accepts valid positive integer day values and calls getAccount', async () => {
    const client = makeClient();
    // The spec mock returns the raw return value as-is; returnValue from
    // pollTransaction is 1n (a bigint), which funcResToNative passes through.
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).resolves.toMatchObject({ willId: '1', txHash: 'TXHASH' });
  });
});

// ---------------------------------------------------------------------------
// #150 – invoke() failure branches expose RPC diagnostic fields
// ---------------------------------------------------------------------------

describe('#150 – invoke() diagnostic fields on failure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.getAccount.mockResolvedValue({ accountId: 'GTESTACCOUNT', sequence: '1' });
    mockState.prepareTransaction.mockImplementation(async (tx: { toXDR: () => string }) => ({
      toXDR: tx.toXDR,
    }));
  });

  it('throws InvokeFailedError (not a bare Error) when sendTransaction returns ERROR', async () => {
    const errorResultMock = {
      toXDR: (fmt: string) => (fmt === 'base64' ? 'ENCODED_ERROR_XDR' : 'raw'),
    };
    mockState.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: 'TXHASH_ERR',
      errorResult: errorResultMock,
    });

    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(InvokeFailedError);
  });

  it('InvokeFailedError carries errorXdr in its diagnostics property', async () => {
    const errorResultMock = {
      toXDR: (fmt: string) => (fmt === 'base64' ? 'ENCODED_ERROR_XDR' : 'raw'),
    };
    mockState.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: 'TXHASH_ERR',
      errorResult: errorResultMock,
    });

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvokeFailedError);
    const err = caught as InvokeFailedError;
    expect(err.diagnostics).toBeDefined();
    expect(err.diagnostics.errorXdr).toBe('ENCODED_ERROR_XDR');
    expect(err.diagnostics.status).toBe('ERROR');
  });

  it('throws InvokeFailedError when polled transaction does not reach SUCCESS', async () => {
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH_FAIL' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'FAILED',
      createdAt: 1_700_000_000,
      returnValue: undefined,
      resultXdr: 'RESULT_XDR_ENCODED',
    });

    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(InvokeFailedError);
  });

  it('InvokeFailedError from poll failure carries status and resultXdr', async () => {
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH_FAIL' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'FAILED',
      createdAt: 1_700_000_000,
      returnValue: undefined,
      resultXdr: 'RESULT_XDR_ENCODED',
    });

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvokeFailedError);
    const err = caught as InvokeFailedError;
    expect(err.diagnostics.status).toBe('FAILED');
    expect(err.diagnostics.resultXdr).toBe('RESULT_XDR_ENCODED');
  });

  it('InvokeFailedError has a meaningful message that includes the method name', async () => {
    mockState.sendTransaction.mockResolvedValue({
      status: 'ERROR',
      hash: 'TXHASH_ERR',
      errorResult: { toXDR: () => 'ERR_XDR' },
    });

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvokeFailedError);
    // The error message should reference the contract method being invoked.
    expect((caught as InvokeFailedError).message).toMatch(/create_will/);
  });
});

// ---------------------------------------------------------------------------
// #152 – submit() catches getAccount() failures as AccountNotFundedError
// ---------------------------------------------------------------------------

describe('#152 – unfunded account surface as AccountNotFundedError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.prepareTransaction.mockImplementation(async (tx: { toXDR: () => string }) => ({
      toXDR: tx.toXDR,
    }));
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: 1n,
    });
  });

  it('throws AccountNotFundedError when getAccount() rejects', async () => {
    mockState.getAccount.mockRejectedValue(new Error('account not found'));

    const client = makeClient();
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).rejects.toThrow(AccountNotFundedError);
  });

  it('AccountNotFundedError message communicates the funding requirement', async () => {
    mockState.getAccount.mockRejectedValue(new Error('Not Found'));

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AccountNotFundedError);
    const err = caught as AccountNotFundedError;
    // Message must not be the raw "Not Found" RPC string.
    expect(err.message).not.toMatch(/Not Found/);
    // Message must clearly explain the funding requirement.
    expect(err.message.toLowerCase()).toMatch(/fund/);
  });

  it('AccountNotFundedError wraps the original RPC error as its cause', async () => {
    const rpcError = new Error('account not found on testnet');
    mockState.getAccount.mockRejectedValue(rpcError);

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AccountNotFundedError);
    expect((caught as AccountNotFundedError).cause).toBe(rpcError);
  });

  it('AccountNotFundedError is not thrown when getAccount() succeeds', async () => {
    mockState.getAccount.mockResolvedValue({ accountId: 'GTESTACCOUNT', sequence: '1' });

    const client = makeClient();
    // Should resolve, not reject with AccountNotFundedError
    await expect(
      client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      }),
    ).resolves.toMatchObject({ willId: '1', txHash: 'TXHASH' });
  });

  it('AccountNotFundedError stores the public key that failed to load', async () => {
    mockState.getAccount.mockRejectedValue(new Error('account not found'));

    const client = makeClient();
    let caught: unknown;
    try {
      await client.createWill({
        token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
        amount: '1000000',
        beneficiaries: VALID_BENEFICIARIES,
        checkinPeriodDays: 90,
        gracePeriodDays: 7,
        guardians: [],
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(AccountNotFundedError);
    // publicKey should be set to the wallet's address
    expect((caught as AccountNotFundedError).publicKey).toBe('GTESTACCOUNT');
  });
});
