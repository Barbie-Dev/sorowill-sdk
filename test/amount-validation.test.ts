import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillInvalidAmountError } from '../src/errors';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

function createRpcServer(): SoroWillRpcServer {
  return {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction() {
      return { result: { retval: VOID_SCVAL } } as never;
    },
    async getAccount(address: string) {
      return new Account(address, '1');
    },
    async prepareTransaction(tx: unknown) {
      return tx as never;
    },
    async sendTransaction() {
      return { status: 'PENDING', hash: 'abc123' } as never;
    },
    async pollTransaction() {
      return {
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: VOID_SCVAL,
      } as never;
    },
  };
}

function createSpec(returnValues: Record<string, unknown[]>) {
  return {
    funcArgsToScVals(_method: string, _args: Record<string, unknown>): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string, _value: xdr.ScVal): unknown {
      const queue = returnValues[method];
      if (!queue || queue.length === 0) return undefined;
      return queue.shift();
    },
  };
}

function makeWalletAdapter() {
  return {
    async isConnected(): Promise<boolean> {
      return true;
    },
    async connect() {
      return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
    },
    async reconnect() {
      return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
    },
    async disconnect(): Promise<void> {},
    async getPublicKey(): Promise<string> {
      return TEST_ACCOUNT;
    },
    async signTransaction(transactionXdr: string): Promise<string> {
      return transactionXdr;
    },
  };
}

describe('SoroWillInvalidAmountError', () => {
  it('is an instance of Error', () => {
    const err = new SoroWillInvalidAmountError('0');
    expect(err).toBeInstanceOf(Error);
  });

  it('exposes the invalid amount', () => {
    const err = new SoroWillInvalidAmountError('abc');
    expect(err.amount).toBe('abc');
  });

  it('has a descriptive message', () => {
    const err = new SoroWillInvalidAmountError('-5');
    expect(err.message).toMatch(/Invalid amount/);
    expect(err.message).toContain('-5');
  });
});

describe('createWill amount validation', () => {
  function makeClient() {
    return new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: makeWalletAdapter(),
      readCache: false,
      spec: createSpec({ create_will: [1n] }),
      rpcServer: createRpcServer(),
    });
  }

  const baseParams = {
    token: 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526',
    beneficiaries: [
      { address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG', percentage: 100 },
    ],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    guardians: [] as string[],
  };

  it('throws SoroWillInvalidAmountError for a zero amount', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...baseParams, amount: '0' }),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a negative amount', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...baseParams, amount: '-100' }),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a malformed (non-numeric) string', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...baseParams, amount: 'not-a-number' }),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a decimal string', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...baseParams, amount: '100.50' }),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for an empty string', async () => {
    const client = makeClient();
    await expect(
      client.createWill({ ...baseParams, amount: '' }),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('does not throw for a valid positive integer amount', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: makeWalletAdapter(),
      readCache: false,
      spec: createSpec({ create_will: [1n] }),
      rpcServer: createRpcServer(),
    });
    await expect(
      client.createWill({ ...baseParams, amount: '1000000' }),
    ).resolves.toMatchObject({ willId: '1', txHash: 'abc123' });
  });
});

describe('topUp amount validation', () => {
  function makeClient() {
    return new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: makeWalletAdapter(),
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer(),
    });
  }

  it('throws SoroWillInvalidAmountError for a zero amount', async () => {
    const client = makeClient();
    await expect(
      client.topUp('1', '0'),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a negative amount', async () => {
    const client = makeClient();
    await expect(
      client.topUp('1', '-500'),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a malformed (non-numeric) string', async () => {
    const client = makeClient();
    await expect(
      client.topUp('1', 'abc'),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for a decimal string', async () => {
    const client = makeClient();
    await expect(
      client.topUp('1', '500.50'),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('throws SoroWillInvalidAmountError for an empty string', async () => {
    const client = makeClient();
    await expect(
      client.topUp('1', ''),
    ).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('does not throw for a valid positive integer amount', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: makeWalletAdapter(),
      readCache: false,
      spec: createSpec({}),
      rpcServer: createRpcServer(),
    });
    await expect(
      client.topUp('1', '500000'),
    ).resolves.toMatchObject({ txHash: 'abc123' });
  });
});
