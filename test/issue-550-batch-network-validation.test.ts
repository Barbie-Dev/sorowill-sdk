/**
 * Tests for issue #550: `BatchOperation` doesn't validate that all operations
 * are for the same network.
 *
 * Fix: `SoroWillClient.batch()` validates the `network` field of every
 * operation before any transaction is built, signed, or submitted. Operations
 * that omit `network` inherit the client's network. A batch whose operations
 * declare different networks, or that declares a network other than the one
 * the client is configured for, is rejected with `BatchNetworkMismatchError`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/wallet', () => ({
  freighterAdapter: {
    getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  },
  getDefaultWalletAdapter: vi.fn(() => ({
    getPublicKey: async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    signTransaction: async (transactionXdr: string) => transactionXdr,
    isConnected: async () => true,
    connect: async () => ({ publicKey: 'GAAA', network: 'TESTNET', networkPassphrase: 'pass' }),
    reconnect: async () => ({ publicKey: 'GAAA', network: 'TESTNET', networkPassphrase: 'pass' }),
    disconnect: async () => undefined,
  })),
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  normalizeSignatureResponse: vi.fn((resp: unknown) => resp),
  signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
}));

import { SoroWillClient } from '../src/SoroWillClient';
import { BatchNetworkMismatchError } from '../src/errors';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function makeClient(network: 'testnet' | 'mainnet'): {
  client: SoroWillClient;
  getAccount: ReturnType<typeof vi.fn>;
  prepareTransaction: ReturnType<typeof vi.fn>;
} {
  const getAccount = vi.fn();
  const prepareTransaction = vi.fn();
  const client = new SoroWillClient({
    network,
    contractId: CONTRACT_ID,
    rpcServer: { getAccount, prepareTransaction } as never,
  });
  return { client, getAccount, prepareTransaction };
}

describe('issue #550 — batch operations must target a single network', () => {
  it('rejects an operation whose network differs from the client network', async () => {
    const { client, getAccount, prepareTransaction } = makeClient('testnet');

    await expect(
      client.batch([{ method: 'create_will', args: {}, network: 'mainnet' }]),
    ).rejects.toThrow(BatchNetworkMismatchError);

    // Rejected before any transaction was built, signed, or submitted.
    expect(getAccount).not.toHaveBeenCalled();
    expect(prepareTransaction).not.toHaveBeenCalled();
  });

  it('exposes the client network and the offending operation network on the error', async () => {
    const { client } = makeClient('testnet');

    const error = await client
      .batch([{ method: 'create_will', args: {}, network: 'mainnet' }])
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BatchNetworkMismatchError);
    const mismatch = error as BatchNetworkMismatchError;
    expect(mismatch.clientNetwork).toBe('testnet');
    expect(mismatch.operationNetwork).toBe('mainnet');
    expect(mismatch.operationIndex).toBe(0);
    expect(mismatch.message).toContain('mainnet');
    expect(mismatch.message).toContain('testnet');
  });

  it('rejects a batch whose operations declare different networks', async () => {
    const { client, getAccount } = makeClient('testnet');

    const error = await client
      .batch([
        { method: 'create_will', args: {}, network: 'testnet' },
        { method: 'check_in', args: {}, network: 'mainnet' },
      ])
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BatchNetworkMismatchError);
    const mismatch = error as BatchNetworkMismatchError;
    expect(mismatch.operationIndex).toBe(1);
    expect(mismatch.conflictingOperationIndex).toBe(0);
    expect(mismatch.conflictingNetwork).toBe('testnet');
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('accepts an operation that declares the client network', async () => {
    const { client } = makeClient('testnet');

    // The batch-size guard still applies, but the network check passes first.
    const error = await client
      .batch([
        { method: 'create_will', args: {}, network: 'testnet' },
        { method: 'check_in', args: {}, network: 'testnet' },
      ])
      .catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(BatchNetworkMismatchError);
  });

  it('treats an operation without a network as inheriting the client network', async () => {
    const { client } = makeClient('testnet');

    // No `network` field: the check must not reject the operation.
    const error = await client
      .batch([{ method: 'create_will', args: {} }])
      .catch((err: unknown) => err);

    // The batch proceeds and fails later (no spec / no account), never with a
    // network mismatch.
    expect(error).not.toBeInstanceOf(BatchNetworkMismatchError);
  });
});
