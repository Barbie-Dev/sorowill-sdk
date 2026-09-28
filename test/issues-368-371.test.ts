import { describe, expect, it, vi } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  Operation,
  Transaction,
} from '@stellar/stellar-sdk';
import { SoroWillClient, WalletNetworkMismatchError } from '../src/index';
import { SoroWillError } from '../src/errors';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function baseServer(overrides: Record<string, unknown> = {}) {
  return {
    simulateTransaction: vi.fn(),
    getAccount: vi.fn(),
    prepareTransaction: vi.fn(),
    sendTransaction: vi.fn(),
    pollTransaction: vi.fn(),
    getContractWasmByContractId: vi.fn(),
    ...overrides,
  };
}

describe('#369 isHealthy()', () => {
  it('returns false when the node reports an unhealthy status', async () => {
    const server = baseServer({ getHealth: vi.fn().mockResolvedValue({ status: 'unhealthy' }) });
    const client = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_ID, rpcServer: server as any });
    await expect(client.isHealthy()).resolves.toBe(false);
  });

  it('returns false when getHealth hangs past the client timeout', async () => {
    const server = baseServer({ getHealth: vi.fn(() => new Promise(() => {})) });
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server as any,
      timeoutMs: 20,
    });
    await expect(client.isHealthy()).resolves.toBe(false);
  });
});

describe('#370 assertWalletNetwork()', () => {
  const wallet = (getNetwork: () => Promise<unknown>) =>
    ({ getPublicKey: vi.fn(), signTransaction: vi.fn(), getNetwork }) as any;

  it('surfaces a rejecting getNetwork instead of passing silently', async () => {
    const cause = new Error('wallet locked');
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: wallet(() => Promise.reject(cause)),
    });
    const error = await client
      .assertWalletNetwork({ networkPassphrase: Networks.TESTNET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SoroWillError);
    expect((error as Error).cause).toBe(cause);
  });

  it('treats an empty passphrase as a mismatch', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: wallet(() => Promise.resolve({ network: '', networkPassphrase: '' })),
    });
    await expect(
      client.assertWalletNetwork({ networkPassphrase: Networks.TESTNET }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
  });
});

describe('#371 polling subscription with a throwing listener', () => {
  it('reports the error with the event id, keeps delivering, and advances the cursor', async () => {
    const bodies: Array<{ params: { pagination: { cursor?: string } } }> = [];
    const pages = [
      { events: [{ id: 'evt-1' }, { id: 'evt-2' }], nextCursor: 'c1' },
      { events: [], nextCursor: 'c1' },
    ];
    const fetchImpl = vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return { json: async () => ({ result: pages.shift() ?? { events: [] } }) };
    });
    const client = new SoroWillClient({ network: 'testnet', contractId: CONTRACT_ID, fetch: fetchImpl as any });

    const delivered: string[] = [];
    const onError = vi.fn();
    const subscription = await client.subscribeToEvents(
      (event) => {
        delivered.push(event.id);
        if (event.id === 'evt-1') throw new Error('listener failed');
      },
      { transport: 'polling', pollIntervalMs: 5, onError },
    );
    await vi.waitFor(() => expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(2));
    subscription.close();

    expect(delivered).toEqual(['evt-1', 'evt-2']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0].message).toContain('evt-1');
    expect(bodies[1]!.params.pagination.cursor).toBe('c1');
  });
});

describe('#368 autoFeeBumpOnTimeout resubmission', () => {
  it('reuses the pending sequence number and bumps the fee from fee stats', async () => {
    const keypair = Keypair.random();
    const publicKey = keypair.publicKey();
    const sent: Transaction[] = [];
    const server = baseServer({
      getAccount: vi.fn(async () => new Account(publicKey, '100')),
      prepareTransaction: vi.fn(async (tx: Transaction) => tx),
      sendTransaction: vi.fn(async (tx: Transaction) => {
        sent.push(tx);
        return { status: 'PENDING', hash: `hash-${sent.length}` };
      }),
      getFeeStats: vi.fn(async () => ({ sorobanInclusionFee: { p90: '5000' } })),
    });
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: server as any,
      autoFeeBumpOnTimeout: true,
      wallet: {
        getPublicKey: async () => publicKey,
        signTransaction: async (xdr: string) => xdr,
        getNetwork: async () => ({ network: 'TESTNET', networkPassphrase: Networks.TESTNET }),
      } as any,
    });
    vi.spyOn(client, 'waitForTransaction')
      .mockRejectedValueOnce(new Error('poll timeout'))
      .mockResolvedValueOnce({ createdAt: 1, returnValue: undefined } as any);

    await (client as any).submit([Operation.bumpSequence({ bumpTo: '0' })], 'test');

    expect(sent).toHaveLength(2);
    expect(sent[0]!.sequence).toBe('101');
    expect(sent[1]!.sequence).toBe('101');
    expect(sent[0]!.fee).toBe('100');
    expect(sent[1]!.fee).toBe('5000');
  });
});
