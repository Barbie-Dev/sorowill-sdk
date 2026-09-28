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

import { SoroWillClient } from '../src/SoroWillClient';
import { BeneficiaryValidationError, SoroWillError } from '../src/errors';
import { FreighterWalletAdapter } from '../src/wallet';

const VALID_BENEFICIARIES = [
  { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 60 },
  { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 40 },
];

const BASE_CREATE_WILL_PARAMS = {
  token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
  amount: '1000000',
  beneficiaries: VALID_BENEFICIARIES,
  checkinPeriodDays: 90,
  gracePeriodDays: 7,
  guardians: [],
};

function makeClient() {
  return new SoroWillClient({ network: 'testnet', contractId: 'CCONTRACT' });
}

describe('Freighter wallet adapter', () => {
  it('returns empty network details when Freighter does not provide them', async () => {
    freighterApiMock.getNetworkDetails.mockResolvedValueOnce(undefined);

    const adapter = new FreighterWalletAdapter();
    await expect(adapter.getNetwork()).resolves.toEqual({
      network: '',
      networkPassphrase: '',
    });
  });
});

describe('createWill — beneficiary validation fast-fail', () => {
  beforeEach(() => {
    mockState.sendTransaction.mockReset();
    mockState.pollTransaction.mockReset();
    mockState.prepareTransaction.mockClear();
    mockState.getContractWasmByContractId.mockClear();
    freighterApiMock.getAddress.mockClear();
  });

  it('throws BeneficiaryValidationError for an empty beneficiary list', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...BASE_CREATE_WILL_PARAMS, beneficiaries: [] }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when percentages do not sum to 100', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        ...BASE_CREATE_WILL_PARAMS,
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 50 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 30 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when percentages exceed 100', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        ...BASE_CREATE_WILL_PARAMS,
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 60 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 60 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError for a non-positive percentage (zero)', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        ...BASE_CREATE_WILL_PARAMS,
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 0 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 100 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError for a fractional percentage', async () => {
    const client = makeClient();
    await expect(
      client.createWill({
        ...BASE_CREATE_WILL_PARAMS,
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 33.5 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 66.5 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when more than 10 beneficiaries are supplied', async () => {
    const client = makeClient();
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      address: `GBEN${i}`,
      percentage: i === 0 ? 10 : 9,
    }));
    // Adjust last entry so percentages sum exactly to 100
    tooMany[10].percentage = 10;
    await expect(
      client.createWill({ ...BASE_CREATE_WILL_PARAMS, beneficiaries: tooMany }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError (not a generic error) so callers can distinguish it', async () => {
    const client = makeClient();
    const err = await client
      .createWill({ ...BASE_CREATE_WILL_PARAMS, beneficiaries: [] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BeneficiaryValidationError);
    expect(err).toBeInstanceOf(SoroWillError);
    expect((err as BeneficiaryValidationError).name).toBe('BeneficiaryValidationError');
    expect((err as BeneficiaryValidationError).message).toMatch(/beneficiar/i);
  });

  it('does not call getPublicKey or build a transaction when validation fails', async () => {
    const client = makeClient();
    await client
      .createWill({ ...BASE_CREATE_WILL_PARAMS, beneficiaries: [] })
      .catch(() => undefined);

    expect(freighterApiMock.getAddress).not.toHaveBeenCalled();
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('does NOT throw for a valid single-beneficiary list summing to 100', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED_XDR', error: undefined });
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: 1n,
    });

    const client = makeClient();
    // Should reach the RPC layer (and succeed with our mocks), proving validation passed.
    await expect(
      client.createWill({
        ...BASE_CREATE_WILL_PARAMS,
        beneficiaries: [{ address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 100 }],
      }),
    ).resolves.toMatchObject({ willId: '1', txHash: 'TXHASH' });
  });
});

describe('updateBeneficiaries — beneficiary validation fast-fail', () => {
  beforeEach(() => {
    mockState.sendTransaction.mockReset();
    mockState.pollTransaction.mockReset();
    mockState.prepareTransaction.mockClear();
    mockState.getContractWasmByContractId.mockClear();
    freighterApiMock.getAddress.mockClear();
  });

  it('throws BeneficiaryValidationError for an empty beneficiary list', async () => {
    const client = makeClient();
    await expect(
      client.updateBeneficiaries({ willId: '1', beneficiaries: [] }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when percentages do not sum to 100', async () => {
    const client = makeClient();
    await expect(
      client.updateBeneficiaries({
        willId: '1',
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: 40 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 40 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError for a non-positive percentage (negative)', async () => {
    const client = makeClient();
    await expect(
      client.updateBeneficiaries({
        willId: '1',
        beneficiaries: [
          { address: 'GC6HGXZGSXRY2NLLRYGVHCCDNULAQ6N2QX6Q47UUW42FTH2HBAXTM2WO', percentage: -10 },
          { address: 'GAKUAEWGL2TSFIMEXD2VDVPX2BMJTAFFZEPJS4QQRJJF3X54P6S3QCZ6', percentage: 110 },
        ],
      }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError when more than 10 beneficiaries are supplied', async () => {
    const client = makeClient();
    const tooMany = Array.from({ length: 11 }, (_, i) => ({
      address: `GBEN${i}`,
      percentage: i < 10 ? 9 : 10,
    }));
    await expect(
      client.updateBeneficiaries({ willId: '1', beneficiaries: tooMany }),
    ).rejects.toThrow(BeneficiaryValidationError);
  });

  it('throws BeneficiaryValidationError (not a generic error) so callers can distinguish it', async () => {
    const client = makeClient();
    const err = await client
      .updateBeneficiaries({ willId: '1', beneficiaries: [] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BeneficiaryValidationError);
    expect(err).toBeInstanceOf(SoroWillError);
    expect((err as BeneficiaryValidationError).name).toBe('BeneficiaryValidationError');
    expect((err as BeneficiaryValidationError).message).toMatch(/beneficiar/i);
  });

  it('does not call getPublicKey or build a transaction when validation fails', async () => {
    const client = makeClient();
    await client
      .updateBeneficiaries({ willId: '1', beneficiaries: [] })
      .catch(() => undefined);

    expect(freighterApiMock.getAddress).not.toHaveBeenCalled();
    expect(mockState.sendTransaction).not.toHaveBeenCalled();
  });

  it('does NOT throw for a valid two-beneficiary list summing to 100', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED_XDR2', error: undefined });
    mockState.sendTransaction.mockResolvedValue({ status: 'PENDING', hash: 'TXHASH2' });
    mockState.pollTransaction.mockResolvedValue({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: undefined,
    });

    const client = makeClient();
    await expect(
      client.updateBeneficiaries({ willId: '1', beneficiaries: VALID_BENEFICIARIES }),
    ).resolves.toMatchObject({ txHash: 'TXHASH2' });
  });
});
