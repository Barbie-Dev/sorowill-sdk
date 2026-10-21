import { describe, expect, it } from 'vitest';
import { Account, Networks, xdr } from '@stellar/stellar-sdk';
import { SoroWillClient, WalletNetworkMismatchError } from '../src/index';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

function makeWallet(networkPassphrase: string) {
  return {
    isConnected: async () => true,
    connect: async () => ({
      publicKey: TEST_ACCOUNT,
      network: networkPassphrase === Networks.TESTNET ? 'testnet' : 'mainnet',
      networkPassphrase,
    }),
    reconnect: async () => ({
      publicKey: TEST_ACCOUNT,
      network: networkPassphrase === Networks.TESTNET ? 'testnet' : 'mainnet',
      networkPassphrase,
    }),
    disconnect: async () => {},
    getPublicKey: async () => TEST_ACCOUNT,
    signTransaction: async (xdrStr: string) => xdrStr,
    getNetwork: async () => ({
      network: networkPassphrase === Networks.TESTNET ? 'testnet' : 'mainnet',
      networkPassphrase,
    }),
  } as any;
}

function makeRpcServer() {
  return {
    getContractWasmByContractId: async () => new Uint8Array(),
    simulateTransaction: async () => ({ result: { retval: VOID_SCVAL } }),
    getAccount: async () => new Account(TEST_ACCOUNT, '1'),
    prepareTransaction: async (tx: any) => tx,
    sendTransaction: async () => ({ status: 'PENDING', hash: 'abc123' }),
    pollTransaction: async () => ({ status: 'SUCCESS', createdAt: 1_700_000_000, returnValue: VOID_SCVAL }),
  } as any;
}

function makeSpec() {
  return {
    funcArgsToScVals: () => [],
    funcResToNative: () => undefined,
  } as any;
}

describe('#520 invoke network validation', () => {
  it('throws WalletNetworkMismatchError when wallet is on testnet but client is mainnet', async () => {
    const client = new SoroWillClient({
      network: 'mainnet',
      contractId: CONTRACT_ID,
      wallet: makeWallet(Networks.TESTNET),
      readCache: false,
      rpcServer: makeRpcServer(),
      spec: makeSpec(),
    });

    await expect(client.triggerWill('1')).rejects.toBeInstanceOf(WalletNetworkMismatchError);
  });

  it('throws WalletNetworkMismatchError when wallet is on mainnet but client is testnet', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: makeWallet(Networks.PUBLIC),
      readCache: false,
      rpcServer: makeRpcServer(),
      spec: makeSpec(),
    });

    await expect(client.triggerWill('1')).rejects.toBeInstanceOf(WalletNetworkMismatchError);
  });

  it('proceeds when wallet and client networks match', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: makeWallet(Networks.TESTNET),
      readCache: false,
      rpcServer: makeRpcServer(),
      spec: makeSpec(),
    });

    const result = await client.triggerWill('1');
    expect(result.txHash).toBe('abc123');
  });

  it('assertWalletNetwork throws on mismatch and passes on match', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: makeWallet(Networks.TESTNET),
      readCache: false,
      rpcServer: makeRpcServer(),
    });

    await expect(
      client.assertWalletNetwork({ networkPassphrase: Networks.PUBLIC }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    await expect(
      client.assertWalletNetwork({ networkPassphrase: Networks.TESTNET }),
    ).resolves.toBeUndefined();
  });
});