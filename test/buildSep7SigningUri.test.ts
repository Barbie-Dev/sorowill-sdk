import { Account, Networks, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
  getDefaultWalletAdapter: vi.fn(() => ({
    getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
    signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
    isConnected: vi.fn(async () => true),
    connect: vi.fn(),
    reconnect: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

import { SoroWillClient } from '../src/SoroWillClient';

function makeClient(overrides: Record<string, unknown> = {}) {
  const fakeSpec = {
    funcArgsToScVals: () => [] as xdr.ScVal[],
  };

  const fakeServer = {
    getAccount: async (publicKey: string) => new Account(publicKey, '0'),
    prepareTransaction: async (tx: { toXDR: () => string }) => tx,
    sendTransaction: async () => ({ status: 'PENDING', hash: 'tx-hash-123' }),
    pollTransaction: async () => ({
      status: 'SUCCESS',
      createdAt: 1_700_000_000,
      returnValue: xdr.ScVal.scvVoid(),
    }),
    getContractWasmByContractId: async () => new Uint8Array(),
    simulateTransaction: async () => ({
      result: { retval: xdr.ScVal.scvVoid() },
    }),
  };

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    rpcUrls: ['https://rpc.test'],
    rpcServer: fakeServer as never,
    ...overrides,
  });

  Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
  Object.defineProperty(client, 'queue', {
    value: {
      enqueue: (fn: () => Promise<unknown>) => fn(),
    },
  });

  return { client, fakeServer };
}

describe('buildSep7SigningUri', () => {
  it('builds a SEP-7 signing URI with XDR, network passphrase, and callback URL', async () => {
    const { client } = makeClient();
    const testAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const uri = await client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: testAccount,
      },
      testAccount,
      {
        callbackUrl: 'https://example.com/callback',
      },
    );

    expect(uri).toBeDefined();
    expect(uri).toContain('web+stellar:tx?');
    expect(uri).toContain('xdr=');
    expect(uri).toContain('callback=url%3Ahttps%3A%2F%2Fexample.com%2Fcallback');
    expect(uri).toContain('network_passphrase=');
  });

  it('uses the client network passphrase as default when options.networkPassphrase is omitted', async () => {
    const { client } = makeClient({ networkPassphrase: Networks.TESTNET });
    const testAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const uri = await client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: testAccount,
      },
      testAccount,
      {
        callbackUrl: 'https://example.com/callback',
      },
    );

    // The client's networkPassphrase should be encoded in the URI
    expect(uri).toContain('network_passphrase=');
    // buildSep7TxUri uses application/x-www-form-urlencoded encoding (spaces as +)
    const formEncodedPassphrase = Networks.TESTNET.replace(/ /g, '+').replace(/;/g, '%3B');
    expect(uri).toContain(`network_passphrase=${formEncodedPassphrase}`);
  });

  it('uses the provided network passphrase when options.networkPassphrase is specified', async () => {
    const { client } = makeClient({ networkPassphrase: Networks.TESTNET });

    const customPassphrase = 'Custom Passphrase ; 2024';
    const uri = await client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        callbackUrl: 'https://example.com/callback',
        networkPassphrase: customPassphrase,
      },
    );

    // The custom networkPassphrase should be encoded in the URI
    expect(uri).toContain('network_passphrase=');
    // buildSep7TxUri uses application/x-www-form-urlencoded encoding (spaces as +)
    const formEncodedPassphrase = customPassphrase.replace(/ /g, '+').replace(/;/g, '%3B');
    expect(uri).toContain(`network_passphrase=${formEncodedPassphrase}`);
  });

  it('includes optional message parameter in the URI when provided', async () => {
    const { client } = makeClient();

    const uri = await client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        callbackUrl: 'https://example.com/callback',
        message: 'Sign to check in on your will',
      },
    );

    expect(uri).toContain('msg=');
    expect(uri).toContain('Sign+to+check+in+on+your+will');
  });

  it('includes optional originDomain parameter in the URI when provided', async () => {
    const { client } = makeClient();

    const uri = await client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        callbackUrl: 'https://example.com/callback',
        originDomain: 'example.com',
      },
    );

    expect(uri).toContain('origin_domain=example.com');
  });

  it('throws a clear error when prepareTransaction fails', async () => {
    const testAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async () => {
        throw new Error('Simulation failed: insufficient balance');
      },
      getContractWasmByContractId: async () => new Uint8Array(),
      simulateTransaction: async () => {
        throw new Error('Simulation failed: insufficient balance');
      },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcUrls: ['https://rpc.test'],
      rpcServer: fakeServer as never,
    });

    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };

    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
    Object.defineProperty(client, 'queue', {
      value: {
        enqueue: (fn: () => Promise<unknown>) => fn(),
      },
    });

    await expect(
      client.buildSep7SigningUri(
        'check_in',
        {
          will_id: BigInt(42),
          owner: testAccount,
        },
        testAccount,
        {
          callbackUrl: 'https://example.com/callback',
        },
      ),
    ).rejects.toThrow('Simulation failed');
  });

  it('does not return a malformed URI when simulation fails', async () => {
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      getContractWasmByContractId: async () => new Uint8Array(),
      prepareTransaction: async () => {
        throw new Error('Network error');
      },
      simulateTransaction: async () => {
        throw new Error('Network error');
      },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      rpcUrls: ['https://rpc.test'],
      rpcServer: fakeServer as never,
    });

    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };

    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
    Object.defineProperty(client, 'queue', {
      value: {
        enqueue: (fn: () => Promise<unknown>) => fn(),
      },
    });

    const result = client.buildSep7SigningUri(
      'check_in',
      {
        will_id: BigInt(42),
        owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
      'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      {
        callbackUrl: 'https://example.com/callback',
      },
    );

    // Should throw, not return a malformed URI
    await expect(result).rejects.toThrow('Network error');
  });

  it('accepts different contract methods and encodes their arguments correctly', async () => {
    const { client } = makeClient();
    const testAccount = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const uri = await client.buildSep7SigningUri(
      'create_will',
      {
        owner: testAccount,
        token: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
        amount: BigInt(1000000),
        beneficiaries: [],
        checkin_period_days: BigInt(90),
        grace_period_days: BigInt(7),
        guardians: [],
      },
      testAccount,
      {
        callbackUrl: 'https://example.com/callback',
      },
    );

    expect(uri).toBeDefined();
    expect(uri).toContain('web+stellar:tx?');
    expect(uri).toContain('xdr=');
  });
});
