import { describe, expect, it, vi } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { GuardianValidationError, InvalidContractIdError, RequestTimeoutError } from '../src/errors';
import { formatUSDC, toStroops } from '../src/utils';

const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';
const TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const OWNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const GUARDIAN = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

describe('#373 toStroops respects decimals', () => {
  it.each([
    [0, '12', 12n],
    [2, '1.5', 150n],
    [6, '1.5', 1_500_000n],
    [18, '1.5', 1_500_000_000_000_000_000n],
  ])('decimals=%i parses %s', (decimals, input, expected) => {
    expect(toStroops(input, decimals)).toBe(expected);
  });

  it('rejects more significant fractional digits than decimals allows', () => {
    expect(() => toStroops('1.123', 2)).toThrow(/more than 2 fractional digits/);
    expect(() => toStroops('1.5', 0)).toThrow(/more than 0 fractional digits/);
  });

  it('accepts up to 18 fractional digits when decimals is 18', () => {
    expect(toStroops('0.000000000000000001', 18)).toBe(1n);
  });
});

describe('#374 formatUSDC rounding', () => {
  it.each([
    [0, 15n, '15.00'],
    [1, 15n, '1.50'],
    [2, 199n, '1.99'],
    [7, 12_345_000_000n, '1,234.50'],
  ])('decimals=%i formats %s as %s', (decimals, raw, expected) => {
    expect(formatUSDC(raw, decimals)).toBe(expected);
  });

  it('rounds half up instead of truncating', () => {
    expect(formatUSDC(19_990_000n, 7)).toBe('2.00');
    expect(formatUSDC(10_050_000n, 7)).toBe('1.01');
    expect(formatUSDC(10_049_999n, 7)).toBe('1.00');
    expect(formatUSDC(-10_050_000n, 7)).toBe('-1.01');
  });

  it.each([0, 1, 2, 6, 7, 18])('round trips with toStroops for decimals=%i', (decimals) => {
    // Any amount with at most min(decimals, 2) fractional digits survives a round trip.
    const step = 10n ** BigInt(Math.max(decimals - 2, 0));
    for (const units of [0n, 1n, 50n, 99n, 150n, 123_456n, -250n]) {
      const raw = units * step;
      expect(toStroops(formatUSDC(raw, decimals), decimals)).toBe(raw);
    }
  });
});

describe('#375 createWill validates guardians and token before any RPC call', () => {
  function makeClient() {
    const getAccount = vi.fn(async () => {
      throw new Error('RPC should not be called');
    });
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      readCache: false,
      rpcServer: { getAccount } as unknown as SoroWillRpcServer,
      wallet: {
        isConnected: async () => true,
        connect: async () => ({ publicKey: OWNER, network: 'testnet', networkPassphrase: '' }),
        reconnect: async () => ({ publicKey: OWNER, network: 'testnet', networkPassphrase: '' }),
        disconnect: async () => {},
        getPublicKey: async () => OWNER,
        signTransaction: async (xdr: string) => xdr,
      },
    });
    return { client, getAccount };
  }

  const base = {
    token: TOKEN,
    amount: '100',
    beneficiaries: [{ address: GUARDIAN, percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
  };

  it.each([
    ['invalid_address', ['GBAD']],
    ['duplicate', [GUARDIAN, GUARDIAN]],
    ['owner_is_guardian', [OWNER]],
  ])('rejects %s guardians', async (reason, guardians) => {
    const { client, getAccount } = makeClient();
    const error = await client.createWill({ ...base, guardians }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GuardianValidationError);
    expect((error as GuardianValidationError).reason).toBe(reason);
    expect(getAccount).not.toHaveBeenCalled();
  });

  it('rejects a token that is not a contract address', async () => {
    const { client, getAccount } = makeClient();
    await expect(client.createWill({ ...base, token: OWNER, guardians: [] })).rejects.toBeInstanceOf(
      InvalidContractIdError,
    );
    expect(getAccount).not.toHaveBeenCalled();
  });
});

describe('#372 polling subscription reports failures', () => {
  async function subscribeWith(fetchImpl: typeof fetch, timeoutMs = 30_000) {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      eventRpcUrl: 'https://rpc.example',
      fetch: fetchImpl,
      timeoutMs,
    });
    const onError = vi.fn();
    const sub = await client.subscribeToEvents(() => {}, { transport: 'polling', onError, pollIntervalMs: 60_000 });
    sub.close();
    return onError.mock.calls[0]?.[0] as Error | undefined;
  }

  it('reports a request timeout via onError', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ) as unknown as typeof fetch;
    const error = await subscribeWith(fetchImpl, 20);
    expect(error).toBeInstanceOf(RequestTimeoutError);
  });

  it('reports non-2xx responses with the HTTP status', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch;
    const error = await subscribeWith(fetchImpl);
    expect(error?.message).toMatch(/HTTP status 500/);
  });

  it('reports JSON-RPC error objects with the error code', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad request' } }),
    })) as unknown as typeof fetch;
    const error = await subscribeWith(fetchImpl);
    expect(error?.message).toMatch(/-32600/);
  });
});
