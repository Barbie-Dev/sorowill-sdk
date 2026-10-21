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
    getAccount: vi.fn(async (publicKey: string) => ({ accountId: publicKey, sequence: '1' })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    pollTransaction: vi.fn(),
    prepareTransaction: vi.fn(async (tx: { toXDR: () => string }) => ({ toXDR: tx.toXDR })),
    sendTransaction: vi.fn(),
    simulateTransaction: vi.fn(),
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
  }

  class MockContract {
    constructor(private readonly id: string) {}
    contractId(): string { return this.id; }
    call(method: string, ...args: unknown[]) { return { contractId: this.id, method, args }; }
  }

  class MockServer {
    getAccount = mockState.getAccount;
    getContractWasmByContractId = mockState.getContractWasmByContractId;
    pollTransaction = mockState.pollTransaction;
    prepareTransaction = mockState.prepareTransaction;
    sendTransaction = mockState.sendTransaction;
    simulateTransaction = mockState.simulateTransaction;
  }

  class MockTransactionBuilder {
    private operation: unknown;
    constructor(private readonly account: MockAccount, private readonly options: { fee: string; networkPassphrase: string }) {}
    addOperation(op: unknown): this { this.operation = op; return this; }
    setTimeout(_t: number): this { return this; }
    build() {
      return {
        source: this.account.accountId,
        fee: this.options.fee,
        networkPassphrase: this.options.networkPassphrase,
        operation: this.operation,
        toXDR: () => 'TX_XDR',
      };
    }
    static fromXDR(_xdr: string, _networkPassphrase: string) { return new MockTransaction(); }
  }

  class MockTransaction {}

  return {
    Account: MockAccount,
    BASE_FEE: '100',
    Contract: MockContract,
    StrKey,
    Networks: { PUBLIC: 'PUBLIC', TESTNET: 'TESTNET' },
    Transaction: MockTransaction,
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
        GetTransactionStatus: { SUCCESS: 'SUCCESS' },
        isSimulationError: (sim: { error?: string }) => Boolean(sim.error),
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

import { MAX_CHECKIN_PERIOD_DAYS, SoroWillClient } from '../src/SoroWillClient';
import { BeneficiaryValidationError, CheckinPeriodExceedsTtlError, SoroWillError } from '../src/errors';

const A = 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO';
const B = 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6';
const BASE_CREATE_WILL_PARAMS = {
  token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  amount: '1000000',
  beneficiaries: [{ address: A, percentage: 60 }, { address: B, percentage: 40 }],
  checkinPeriodDays: 90,
  gracePeriodDays: 7,
  guardians: [],
};
function makeClient() {
  return new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
}

describe('createWill issue 537: checkinPeriodDays TTL boundary', () => {
  beforeEach(() => {
    mockState.sendTransaction.mockReset();
    mockState.pollTransaction.mockReset();
    mockState.simulateTransaction.mockReset();
  });
  it('accepts exactly MAX_CHECKIN_PERIOD_DAYS without a TTL error', async () => {
    const client = makeClient();
    await expect(client.createWill({ ...BASE_CREATE_WILL_PARAMS, checkinPeriodDays: MAX_CHECKIN_PERIOD_DAYS })).rejects.not.toThrow(CheckinPeriodExceedsTtlError);
  });
  it('throws CheckinPeriodExceedsTtlError one day over the boundary', async () => {
    const client = makeClient();
    await expect(client.createWill({ ...BASE_CREATE_WILL_PARAMS, checkinPeriodDays: MAX_CHECKIN_PERIOD_DAYS + 1 })).rejects.toThrow(CheckinPeriodExceedsTtlError);
  });
  it('throws for a far-unsafe period without any RPC round-trip', async () => {
    const client = makeClient();
    await expect(client.createWill({ ...BASE_CREATE_WILL_PARAMS, checkinPeriodDays: 10000 })).rejects.toThrow(/exceeds the maximum of .* days.*storage TTL/);
    expect(mockState.simulateTransaction).not.toHaveBeenCalled();
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });
  it('TTL error carries suppliedDays/maxDays and is a SoroWillError', async () => {
    const client = makeClient();
    const err = await client.createWill({ ...BASE_CREATE_WILL_PARAMS, checkinPeriodDays: MAX_CHECKIN_PERIOD_DAYS + 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckinPeriodExceedsTtlError);
    expect(err).toBeInstanceOf(SoroWillError);
    expect((err as CheckinPeriodExceedsTtlError).suppliedDays).toBe(MAX_CHECKIN_PERIOD_DAYS + 5);
    expect((err as CheckinPeriodExceedsTtlError).maxDays).toBe(MAX_CHECKIN_PERIOD_DAYS);
  });
});

describe('updateBeneficiaries issue 538: total percentage validation', () => {
  beforeEach(() => {
    mockState.sendTransaction.mockReset();
    mockState.pollTransaction.mockReset();
  });
  it('rejects a total below 100 (60+30=90)', async () => {
    const client = makeClient();
    await expect(client.updateBeneficiaries({ willId: '1', beneficiaries: [{ address: A, percentage: 60 }, { address: B, percentage: 30 }] })).rejects.toThrow(BeneficiaryValidationError);
  });
  it('rejects a zero-total edge case', async () => {
    const client = makeClient();
    await expect(client.updateBeneficiaries({ willId: '1', beneficiaries: [{ address: A, percentage: 0 }] })).rejects.toThrow(BeneficiaryValidationError);
  });
  it('rejects an over-100 total (60+60=120)', async () => {
    const client = makeClient();
    await expect(client.updateBeneficiaries({ willId: '1', beneficiaries: [{ address: A, percentage: 60 }, { address: B, percentage: 60 }] })).rejects.toThrow(BeneficiaryValidationError);
  });
  it('fails before any RPC round-trip when the total is wrong', async () => {
    const client = makeClient();
    await expect(client.updateBeneficiaries({ willId: '1', beneficiaries: [{ address: A, percentage: 99 }] })).rejects.toThrow(BeneficiaryValidationError);
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });
});
