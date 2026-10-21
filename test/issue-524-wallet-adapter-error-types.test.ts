/**
 * Tests for issue #524: WalletAdapter interface lacks complete error type
 * definitions.
 *
 * Fix: a WalletAdapterError union type documents every typed error the
 * adapter methods can raise, each method carries @throws documentation, and
 * type guards are provided to narrow unknown failures.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const freighterApiMock = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

import {
  ensureValidSession,
  FreighterWalletAdapter,
  isFreighterInstallCheckError,
  isSignTransactionTimeoutError,
  isWalletNetworkMismatchError,
  isWalletSessionError,
  WalletSessionError,
  type WalletAdapter,
  type WalletAdapterError,
} from '../src/wallet';
import {
  FreighterInstallCheckError,
  SignTransactionTimeoutError,
  WalletNetworkMismatchError,
} from '../src/errors';

const TESTNET = 'Test SDF Network ; September 2015';
const ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('WalletAdapterError type guards (#524)', () => {
  it('isWalletSessionError narrows WalletSessionError instances', () => {
    const error = new WalletSessionError('session expired');
    expect(isWalletSessionError(error)).toBe(true);
    expect(isWalletSessionError(new Error('other'))).toBe(false);
    expect(isWalletSessionError(undefined)).toBe(false);
    expect(isWalletSessionError('WalletSessionError')).toBe(false);
  });

  it('isSignTransactionTimeoutError narrows SignTransactionTimeoutError instances', () => {
    const error = new SignTransactionTimeoutError(1_000);
    expect(isSignTransactionTimeoutError(error)).toBe(true);
    expect(isSignTransactionTimeoutError(new Error('other'))).toBe(false);
  });

  it('isWalletNetworkMismatchError narrows WalletNetworkMismatchError instances', () => {
    const error = new WalletNetworkMismatchError(TESTNET, 'Public Global Stellar Network ; September 2015');
    expect(isWalletNetworkMismatchError(error)).toBe(true);
    expect(isWalletNetworkMismatchError(new Error('other'))).toBe(false);
  });

  it('isFreighterInstallCheckError narrows FreighterInstallCheckError instances', () => {
    const error = new FreighterInstallCheckError(5, 'internal failure');
    expect(isFreighterInstallCheckError(error)).toBe(true);
    expect(isFreighterInstallCheckError(new Error('other'))).toBe(false);
  });

  it('every SDK-typed wallet error is assignable to the WalletAdapterError union', () => {
    const errors: WalletAdapterError[] = [
      new WalletSessionError('session'),
      new SignTransactionTimeoutError(1),
      new WalletNetworkMismatchError(TESTNET, 'mainnet'),
      new FreighterInstallCheckError(1, 'boom'),
    ];
    expect(errors).toHaveLength(4);
  });

  it('guards compose with the union for narrowing in a catch handler', () => {
    const describeError = (error: unknown): string => {
      if (isWalletSessionError(error)) return `session: ${error.message}`;
      if (isSignTransactionTimeoutError(error)) return `timeout: ${error.timeoutMs}`;
      if (isWalletNetworkMismatchError(error)) return 'network-mismatch';
      if (isFreighterInstallCheckError(error)) return `install-check: ${error.code}`;
      return 'unknown';
    };

    expect(describeError(new SignTransactionTimeoutError(250))).toBe('timeout: 250');
    expect(describeError(new FreighterInstallCheckError(9, 'x'))).toBe('install-check: 9');
    expect(describeError(new Error('wallet said no'))).toBe('unknown');
  });
});

describe('FreighterWalletAdapter documented error contract (#524)', () => {
  beforeEach(() => {
    freighterApiMock.isConnected.mockReset();
    freighterApiMock.requestAccess.mockReset();
    freighterApiMock.getNetworkDetails.mockReset();
    freighterApiMock.getAddress.mockReset();
    freighterApiMock.signTransaction.mockReset();
  });

  it('connect() rejects with WalletNetworkMismatchError on network mismatch', async () => {
    const adapter = new FreighterWalletAdapter({
      expectedNetworkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    freighterApiMock.requestAccess.mockResolvedValue({ address: ACCOUNT, error: undefined });
    freighterApiMock.getNetworkDetails.mockResolvedValue({
      network: 'TESTNET',
      networkPassphrase: TESTNET,
      error: undefined,
    });

    const error = await adapter.connect().catch((e: unknown) => e);
    expect(isWalletNetworkMismatchError(error)).toBe(true);
    expect(error).toBeInstanceOf(WalletNetworkMismatchError);
  });

  it('isConnected() rejects with FreighterInstallCheckError on internal errors', async () => {
    const adapter = new FreighterWalletAdapter();
    freighterApiMock.isConnected.mockResolvedValue({
      isConnected: false,
      error: { code: 5, message: 'internal extension failure' },
    });

    const error = await adapter.isConnected().catch((e: unknown) => e);
    expect(isFreighterInstallCheckError(error)).toBe(true);
    expect(error).toBeInstanceOf(FreighterInstallCheckError);
  });

  it('signTransaction() rejects with SignTransactionTimeoutError when the wallet hangs', async () => {
    const adapter = new FreighterWalletAdapter();
    // Session bootstrap succeeds, then Freighter never responds.
    freighterApiMock.getAddress.mockResolvedValue({ address: ACCOUNT, error: undefined });
    freighterApiMock.signTransaction.mockReturnValue(new Promise(() => {}));

    const error = await adapter
      .signTransaction('AAAA', { networkPassphrase: TESTNET, timeoutMs: 25 })
      .catch((e: unknown) => e);

    expect(isSignTransactionTimeoutError(error)).toBe(true);
    expect(error).toBeInstanceOf(SignTransactionTimeoutError);
  });

  it('signTransaction() rejects with a plain wallet-reported Error when the user declines', async () => {
    const adapter = new FreighterWalletAdapter();
    freighterApiMock.getAddress.mockResolvedValue({ address: ACCOUNT, error: undefined });
    freighterApiMock.signTransaction.mockResolvedValue({
      error: { message: 'User declined to sign the transaction' },
    });

    await expect(
      adapter.signTransaction('AAAA', { networkPassphrase: TESTNET }),
    ).rejects.toThrow('User declined to sign the transaction');
  });
});

describe('ensureValidSession documented error contract (#524)', () => {
  it('throws WalletSessionError when the session is expired and cannot be refreshed', async () => {
    const adapter = {
      getSession: async () => ({ token: 'stale', expiresAt: 1 }),
    } as unknown as WalletAdapter;

    const error = await ensureValidSession(adapter, 2).catch((e: unknown) => e);
    expect(isWalletSessionError(error)).toBe(true);
    expect(error).toBeInstanceOf(WalletSessionError);
  });

  it('throws WalletSessionError when getSession itself fails', async () => {
    const adapter = {
      getSession: async () => {
        throw new Error('storage unavailable');
      },
    } as unknown as WalletAdapter;

    const error = await ensureValidSession(adapter).catch((e: unknown) => e);
    expect(isWalletSessionError(error)).toBe(true);
  });

  it('returns undefined for adapters that do not use session tokens', async () => {
    const adapter = {} as unknown as WalletAdapter;
    await expect(ensureValidSession(adapter)).resolves.toBeUndefined();
  });
});
