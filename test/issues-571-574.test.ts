import { readFileSync } from 'fs';
import { join } from 'path';

import { Account, Contract, Networks, Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { ReadCache, type CachePersistenceAdapter, type PersistedCacheEntry } from '../src/cache';
import { UnsupportedBatchSizeError, SoroWillError } from '../src/errors';
import { SoroWillClient } from '../src/SoroWillClient';
import {
  DEFAULT_SESSION_TTL_MS,
  ensureValidSession,
  type WalletAdapter,
  type WalletSession,
} from '../src/wallet';

const SRC_DIR = join(__dirname, '..', 'src');
const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

// ---------------------------------------------------------------------------
// #571 – batch maximum batch size: documented, enforced, and covered by tests
// ---------------------------------------------------------------------------

describe('#571 – batch() maximum batch size', () => {
  function makeClient(): SoroWillClient {
    return new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      rpcServer: { getAccount: vi.fn() } as never,
    });
  }

  it('rejects a batch of two operations with UnsupportedBatchSizeError', async () => {
    await expect(
      makeClient().batch([
        { method: 'first_operation', args: {} },
        { method: 'second_operation', args: {} },
      ]),
    ).rejects.toThrow(UnsupportedBatchSizeError);
  });

  it('rejects an empty batch with RangeError', async () => {
    await expect(makeClient().batch([])).rejects.toThrow(RangeError);
  });

  it('the UnsupportedBatchSizeError message explains the one-operation limit', async () => {
    await expect(
      makeClient().batch([
        { method: 'op_a', args: {} },
        { method: 'op_b', args: {} },
        { method: 'op_c', args: {} },
      ]),
    ).rejects.toThrow(/may contain only one operation/);
  });

  it('documents the maximum batch size of 1 in the batch() JSDoc', () => {
    const source = readFileSync(join(SRC_DIR, 'SoroWillClient.ts'), 'utf-8');
    const batchDocIndex = source.indexOf('async batch(');
    expect(batchDocIndex).toBeGreaterThan(0);
    // The JSDoc block immediately above `async batch(` must state the max size.
    const docBlock = source.slice(batchDocIndex - 2_000, batchDocIndex);
    expect(docBlock).toContain('**Maximum batch size: 1.**');
  });
});

// ---------------------------------------------------------------------------
// #572 – cache persistence adapter failures are handled gracefully
// ---------------------------------------------------------------------------

function makeFailingPersistence(): CachePersistenceAdapter & {
  writeCalls: number;
  deleteCalls: number;
  clearCalls: number;
} {
  return {
    writeCalls: 0,
    deleteCalls: 0,
    clearCalls: 0,
    async readAll(): Promise<PersistedCacheEntry[]> {
      return [];
    },
    async write(): Promise<void> {
      this.writeCalls += 1;
      throw new Error('disk full');
    },
    async delete(): Promise<void> {
      this.deleteCalls += 1;
      throw new Error('disk full');
    },
    async clear(): Promise<void> {
      this.clearCalls += 1;
      throw new Error('disk full');
    },
  };
}

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('#572 – ReadCache persistence failure handling', () => {
  it('invokes onPersistenceFailure when a write fails and keeps the in-memory entry by default', async () => {
    const failures: Array<{ key: string; error: unknown }> = [];
    const cache = new ReadCache({
      ttlMs: 1_000,
      persistence: makeFailingPersistence(),
      onPersistenceFailure: (key, error) => failures.push({ key, error }),
    });
    await cache.ready();

    cache.set('will:1', { id: '1' });
    await flushAsync();

    expect(failures).toHaveLength(1);
    expect(failures[0]!.key).toBe('will:1');
    expect((failures[0]!.error as Error).message).toBe('disk full');
    // Default behaviour: the in-memory entry survives a persistence failure.
    expect(cache.get('will:1')).toEqual({ id: '1' });
  });

  it('rolls back the in-memory entry when rollbackOnPersistenceFailure is enabled', async () => {
    const failures: Array<{ key: string; error: unknown }> = [];
    const cache = new ReadCache({
      ttlMs: 1_000,
      persistence: makeFailingPersistence(),
      rollbackOnPersistenceFailure: true,
      onPersistenceFailure: (key, error) => failures.push({ key, error }),
    });
    await cache.ready();

    cache.set('will:2', { id: '2' });
    await flushAsync();

    expect(failures).toHaveLength(1);
    expect(failures[0]!.key).toBe('will:2');
    // Rolled back: memory and persistence stay in sync (both lack the entry).
    expect(cache.get('will:2')).toBeUndefined();
  });

  it('invokes onPersistenceFailure when invalidate() delete fails, without throwing', async () => {
    const failures: Array<{ key: string; error: unknown }> = [];
    const cache = new ReadCache({
      ttlMs: 1_000,
      persistence: makeFailingPersistence(),
      onPersistenceFailure: (key, error) => failures.push({ key, error }),
    });
    await cache.ready();
    cache.set('will:3', { id: '3' });

    // Must not reject even though persistence.delete throws.
    await expect(cache.invalidate('will:3')).resolves.toBeUndefined();
    expect(failures.some((f) => f.key === 'will:3')).toBe(true);
    // In-memory entry is removed regardless of persistence outcome.
    expect(cache.get('will:3')).toBeUndefined();
  });

  it('invokes onPersistenceFailure when clear() persistence fails, without throwing', async () => {
    const failures: Array<{ key: string; error: unknown }> = [];
    const cache = new ReadCache({
      ttlMs: 1_000,
      persistence: makeFailingPersistence(),
      onPersistenceFailure: (key, error) => failures.push({ key, error }),
    });

    expect(() => cache.clear()).not.toThrow();
    await flushAsync();
    // The clear persistence failure was reported.
    expect(failures.some((f) => f.key === '__clear__')).toBe(true);
    // In-memory entries are cleared regardless of persistence outcome.
    expect(cache.get('anything')).toBeUndefined();
  });

  it('keeps working in-memory after repeated persistence failures (no unhandled rejections)', async () => {
    const cache = new ReadCache({
      ttlMs: 1_000,
      persistence: makeFailingPersistence(),
    });
    await cache.ready();

    for (let i = 0; i < 5; i += 1) {
      cache.set(`key:${i}`, i);
    }
    await flushAsync();

    for (let i = 0; i < 5; i += 1) {
      expect(cache.get(`key:${i}`)).toBe(i);
    }
  });
});

// ---------------------------------------------------------------------------
// #573 – duplicate transaction signing prevention
// ---------------------------------------------------------------------------

interface SubmitUnserializedFn {
  (
    operations: unknown[],
    label: string,
  ): Promise<{ txHash: string; createdAt: number; returnValue: unknown }>;
}

describe('#573 – duplicate transaction signing prevention', () => {
  const walletPublicKey = Keypair.random().publicKey();

  function buildFixedTransactionXdr(): string {
    // Build one real transaction so the stub XDR is parseable by
    // TransactionBuilder.fromXDR downstream.
    const account = new Account(walletPublicKey, '0');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .addOperation(new Contract(CONTRACT_ID).call('check_in'))
      .build()
      .toXDR();
  }

  /** Builds a client whose wallet signTransaction can be gated mid-flight. */
  function makeSigningHarness() {
    let signCalls = 0;
    let releaseFirstSign: ((xdr: string) => void) | undefined;
    const firstSignGate = new Promise<string>((resolve) => {
      releaseFirstSign = resolve;
    });

    const wallet: WalletAdapter = {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: walletPublicKey,
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      }),
      reconnect: async () => ({
        publicKey: walletPublicKey,
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      }),
      disconnect: async () => undefined,
      getPublicKey: async () => walletPublicKey,
      signTransaction: vi.fn(async (xdr: string) => {
        signCalls += 1;
        if (signCalls === 1) {
          // Hold the first signing call open so a second submission can
          // attempt to sign the identical transaction concurrently.
          await firstSignGate;
        }
        return xdr;
      }),
    };

    // Deterministic prepared-XDR stub so two submissions of the same
    // operation produce the identical transaction key.
    const fixedXdr = buildFixedTransactionXdr();
    const rpcServer = {
      getAccount: vi.fn(async (publicKey: string) => new Account(publicKey, '0')),
      prepareTransaction: vi.fn(async () => ({ toXDR: () => fixedXdr })),
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'TXHASH_1' })),
      pollTransaction: vi.fn(async () => ({
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: undefined,
      })),
    };

    const spec = {
      funcArgsToScVals: () => [],
      funcResToNative: (_m: string, v: unknown) => v,
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet,
      rpcServer: rpcServer as never,
      spec,
      readCache: false,
    });

    return {
      client,
      rpcServer,
      fixedXdr,
      releaseFirstSign: () => releaseFirstSign?.(fixedXdr),
      getSignCalls: () => signCalls,
      getTrackedHashCount: () =>
        (client as unknown as { signedTransactionHashes: Set<string> }).signedTransactionHashes.size,
      submitUnserialized: (
        client as unknown as { submitUnserialized: SubmitUnserializedFn }
      ).submitUnserialized.bind(client),
    };
  }

  it('tracks the transaction XDR while a submission is in-flight and releases it after completion', async () => {
    const harness = makeSigningHarness();
    const op = new Contract(CONTRACT_ID).call('check_in');

    const submission = harness.submitUnserialized([op], 'check_in');

    // Wait until the first submission reaches the (gated) wallet signing step.
    await vi.waitFor(() => expect(harness.getSignCalls()).toBe(1));

    // The transaction hash is tracked while signing is in flight.
    expect(harness.getTrackedHashCount()).toBe(1);

    // Complete the first submission.
    harness.releaseFirstSign();
    await expect(submission).resolves.toMatchObject({ txHash: 'TXHASH_1' });

    // The hash is released once the submission completes.
    expect(harness.getTrackedHashCount()).toBe(0);
  });

  it('rejects a concurrent duplicate signing of the same transaction', async () => {
    const harness = makeSigningHarness();
    const op = new Contract(CONTRACT_ID).call('check_in');

    const original = harness.submitUnserialized([op], 'check_in');
    await vi.waitFor(() => expect(harness.getSignCalls()).toBe(1));

    // Second submission of the identical transaction while the first is
    // still signing must be rejected before reaching the wallet.
    const duplicate = harness.submitUnserialized([op], 'check_in');
    await expect(duplicate).rejects.toThrow(SoroWillError);
    await expect(duplicate).rejects.toThrow(/already been signed by this client/);

    // Only the first submission ever reached the wallet signer.
    expect(harness.getSignCalls()).toBe(1);
    // The rejected duplicate did not release the hash held by the original.
    expect(harness.getTrackedHashCount()).toBe(1);

    harness.releaseFirstSign();
    await expect(original).resolves.toMatchObject({ txHash: 'TXHASH_1' });
    expect(harness.getTrackedHashCount()).toBe(0);
  });

  it('allows a new submission of the same transaction after the previous one completes', async () => {
    const harness = makeSigningHarness();
    const op = new Contract(CONTRACT_ID).call('check_in');

    const first = harness.submitUnserialized([op], 'check_in');
    await vi.waitFor(() => expect(harness.getSignCalls()).toBe(1));
    harness.releaseFirstSign();
    await first;

    // Sequential retry with an identical transaction is not blocked.
    await expect(harness.submitUnserialized([op], 'check_in')).resolves.toMatchObject({
      txHash: 'TXHASH_1',
    });
    expect(harness.getSignCalls()).toBe(2);
    expect(harness.getTrackedHashCount()).toBe(0);
  });

  it('releases the tracked hash when signing fails, so retries are not blocked', async () => {
    const rpcServer = {
      getAccount: vi.fn(async (publicKey: string) => new Account(publicKey, '0')),
      prepareTransaction: vi.fn(async () => ({ toXDR: () => buildFixedTransactionXdr() })),
      sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: 'TXHASH_1' })),
      pollTransaction: vi.fn(async () => ({
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: undefined,
      })),
    };

    const failingClient = new SoroWillClient({
      network: 'testnet',
      contractId: CONTRACT_ID,
      wallet: {
        isConnected: async () => true,
        connect: async () => ({
          publicKey: walletPublicKey,
          network: 'testnet',
          networkPassphrase: Networks.TESTNET,
        }),
        reconnect: async () => ({
          publicKey: walletPublicKey,
          network: 'testnet',
          networkPassphrase: Networks.TESTNET,
        }),
        disconnect: async () => undefined,
        getPublicKey: async () => walletPublicKey,
        signTransaction: vi.fn(async () => {
          throw new Error('user rejected the transaction');
        }),
      },
      rpcServer: rpcServer as never,
      spec: { funcArgsToScVals: () => [], funcResToNative: (_m: string, v: unknown) => v },
      readCache: false,
    });

    const submit = (
      failingClient as unknown as { submitUnserialized: SubmitUnserializedFn }
    ).submitUnserialized.bind(failingClient);

    const op = new Contract(CONTRACT_ID).call('check_in');
    // mapContractError may wrap the error; match on the underlying message.
    await expect(submit([op], 'check_in')).rejects.toThrow(/user rejected the transaction/);

    const tracked = (failingClient as unknown as { signedTransactionHashes: Set<string> })
      .signedTransactionHashes;
    expect(tracked.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #574 – WalletSession.expiresAt timezone assumptions
// ---------------------------------------------------------------------------

describe('#574 – WalletSession.expiresAt timezone documentation and validation', () => {
  it('documents expiresAt as UTC milliseconds since the Unix epoch in wallet.ts', () => {
    const source = readFileSync(join(SRC_DIR, 'wallet.ts'), 'utf-8');
    const sessionIndex = source.indexOf('export interface WalletSession');
    expect(sessionIndex).toBeGreaterThan(0);
    const interfaceBlock = source.slice(sessionIndex, sessionIndex + 1_200);
    expect(interfaceBlock).toContain('UTC milliseconds since the Unix epoch');
    expect(interfaceBlock).toContain('Date.now()');
    expect(interfaceBlock).toContain('@example');
  });

  it('DEFAULT_SESSION_TTL_MS is expressed in milliseconds (15 minutes)', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });

  function makeSessionWallet(session: WalletSession): WalletAdapter {
    return {
      isConnected: async () => true,
      connect: async () => ({
        publicKey: 'GTEST',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      }),
      reconnect: async () => ({
        publicKey: 'GTEST',
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
      }),
      disconnect: async () => undefined,
      getPublicKey: async () => 'GTEST',
      signTransaction: async (xdr: string) => xdr,
      getSession: async () => session,
    };
  }

  it('treats expiresAt as UTC millis compatible with Date.now()', async () => {
    const wallet = makeSessionWallet({
      token: 'session-token',
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
    });

    await expect(ensureValidSession(wallet)).resolves.toBe('session-token');
  });

  it('refreshes a session whose expiresAt is in the past (UTC millis comparison)', async () => {
    const wallet = makeSessionWallet({
      token: 'expired-token',
      expiresAt: Date.now() - 1_000,
    });
    wallet.refreshSession = async () => ({
      token: 'refreshed-token',
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
    });

    await expect(ensureValidSession(wallet)).resolves.toBe('refreshed-token');
  });

  it('treats a session with expiresAt exactly now as expired (expiresAt <= now)', async () => {
    const now = Date.now();
    const wallet = makeSessionWallet({ token: 'boundary-token', expiresAt: now });
    wallet.refreshSession = async () => ({
      token: 'refreshed-token',
      expiresAt: now + DEFAULT_SESSION_TTL_MS,
    });

    // Passing the exact same `now` value the session expires at must be
    // treated as expired per the documented `expiresAt <= now` rule.
    await expect(ensureValidSession(wallet, now)).resolves.toBe('refreshed-token');
  });
});
