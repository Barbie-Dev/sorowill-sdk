import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { SoroWillInvalidAmountError } from '../src/errors';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();
const NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015';

function createRpcServer() {
  return {
    getContractWasmByContractId: vi.fn(async () => new Uint8Array()),
    simulateTransaction: vi.fn(async () => ({ result: { retval: VOID_SCVAL } }) as never),
    getAccount: vi.fn(async (address: string) => new Account(address, '1')),
    prepareTransaction: vi.fn(async (tx: unknown) => tx as never),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'abc123' }) as never),
    pollTransaction: vi.fn(
      async () => ({ status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL }) as never,
    ),
  };
}

function createWalletAdapter() {
  const connection = { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: NETWORK_PASSPHRASE };
  return {
    isConnected: vi.fn(async () => true),
    connect: vi.fn(async () => connection),
    reconnect: vi.fn(async () => connection),
    disconnect: vi.fn(async () => {}),
    getPublicKey: vi.fn(async () => TEST_ACCOUNT),
    signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
  };
}

function makeClient() {
  const rpcServer = createRpcServer();
  const wallet = createWalletAdapter();
  const client = new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    wallet,
    readCache: false,
    spec: {
      funcArgsToScVals: () => [] as xdr.ScVal[],
      funcResToNative: () => undefined,
    },
    rpcServer: rpcServer as unknown as SoroWillRpcServer,
  });
  return { client, rpcServer, wallet };
}

describe('Issue #577: topUp validates amount is positive', () => {
  const invalidAmounts: [string, unknown][] = [
    ['zero', '0'],
    ['zero with leading zeros', '000'],
    ['negative', '-1'],
    ['large negative', '-1000000'],
    ['decimal', '1.5'],
    ['empty string', ''],
    ['whitespace-padded', ' 100 '],
    ['non-numeric', 'abc'],
    ['exponent notation', '1e6'],
    ['number instead of string', 100],
    ['bigint instead of string', 100n],
    ['undefined', undefined],
    ['null', null],
  ];

  it.each(invalidAmounts)('rejects a %s amount with SoroWillInvalidAmountError', async (_label, amount) => {
    const { client } = makeClient();
    await expect(client.topUp('1', amount as string)).rejects.toBeInstanceOf(SoroWillInvalidAmountError);
  });

  it('includes the offending amount in a clear error message', async () => {
    const { client } = makeClient();
    const error = await client.topUp('1', '-5').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SoroWillInvalidAmountError);
    expect((error as SoroWillInvalidAmountError).amount).toBe('-5');
    expect((error as Error).message).toMatch(/Invalid amount "-5"/);
    expect((error as Error).message).toMatch(/positive integer/);
  });

  it('validates before any wallet or RPC interaction', async () => {
    const { client, rpcServer, wallet } = makeClient();

    await expect(client.topUp('1', '0')).rejects.toBeInstanceOf(SoroWillInvalidAmountError);

    expect(wallet.getPublicKey).not.toHaveBeenCalled();
    expect(wallet.signTransaction).not.toHaveBeenCalled();
    expect(rpcServer.simulateTransaction).not.toHaveBeenCalled();
    expect(rpcServer.sendTransaction).not.toHaveBeenCalled();
  });

  it('accepts the smallest positive amount', async () => {
    const { client } = makeClient();
    await expect(client.topUp('1', '1')).resolves.toEqual({ txHash: 'abc123' });
  });

  it('accepts amounts larger than Number.MAX_SAFE_INTEGER', async () => {
    const { client } = makeClient();
    await expect(client.topUp('1', '9007199254740993')).resolves.toEqual({ txHash: 'abc123' });
  });
});
