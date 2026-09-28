import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import { LedgerWalletAdapter, type LedgerStellarApp } from '../src/adapters/ledger';
import { WalletNetworkMismatchError } from '../src/errors';
import { InFlightTracker } from '../src/inFlightTracker';
import { RequestQueue } from '../src/requestQueue';
import { RpcEndpointPool } from '../src/rpc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('#380 RequestQueue drops aborted queued requests', () => {
  it('never runs a request aborted while queued', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1 });
    const first = deferred<string>();
    const p1 = queue.enqueue(() => first.promise);

    const controller = new AbortController();
    const secondRun = vi.fn().mockResolvedValue('second');
    const p2 = queue.enqueue(secondRun, undefined, controller.signal);
    controller.abort(new Error('aborted'));
    await expect(p2).rejects.toThrow('aborted');

    first.resolve('first');
    await expect(p1).resolves.toBe('first');
    await new Promise((r) => setTimeout(r, 0));
    expect(secondRun).not.toHaveBeenCalled();
  });

  it('does not consume the rate-limit window for an aborted queued request', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 2 });
    const first = deferred<string>();
    const p1 = queue.enqueue(() => first.promise);

    const controller = new AbortController();
    const p2 = queue.enqueue(() => Promise.resolve('aborted'), undefined, controller.signal);
    controller.abort(new Error('aborted'));
    await expect(p2).rejects.toThrow('aborted');

    const thirdRun = vi.fn().mockResolvedValue('third');
    const p3 = queue.enqueue(thirdRun);
    first.resolve('first');
    await p1;
    await expect(p3).resolves.toBe('third');
  });

  it('does not affect a request that is already executing', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1 });
    const controller = new AbortController();
    const run = deferred<string>();
    const p = queue.enqueue(() => run.promise, undefined, controller.signal);
    controller.abort(new Error('aborted'));
    run.resolve('done');
    await expect(p).resolves.toBe('done');
  });
});

describe('#381 InFlightTracker keeps newer entries after abort/clear', () => {
  for (const mode of ['abort', 'clear'] as const) {
    it(`keeps the re-tracked entry after ${mode}() when the old promise settles`, async () => {
      const tracker = new InFlightTracker();
      const old = deferred<string>();
      void tracker.track('will-1', 'checkIn', () => old.promise);

      if (mode === 'abort') tracker.abort('will-1', 'checkIn');
      else tracker.clear();

      let secondSignal: AbortSignal | undefined;
      const second = deferred<string>();
      void tracker.track('will-1', 'checkIn', (signal) => {
        secondSignal = signal;
        return second.promise;
      });

      old.resolve('old');
      await old.promise;
      await new Promise((r) => setTimeout(r, 0));

      expect(tracker.isInFlight('will-1', 'checkIn')).toBe(true);
      tracker.abort('will-1', 'checkIn');
      expect(secondSignal?.aborted).toBe(true);
      second.resolve('second');
    });
  }
});

describe('#382 RpcEndpointPool concurrent failover', () => {
  it('advances by one position when concurrent calls fail on the same endpoint', async () => {
    const pool = new RpcEndpointPool(['https://rpc1.example.com', 'https://rpc2.example.com', 'https://rpc3.example.com']);
    const failures = [deferred<string>(), deferred<string>()];
    const calls: string[] = [];
    let started = 0;

    const operation = (_server: unknown, rpcUrl: string) => {
      calls.push(rpcUrl);
      if (rpcUrl === 'https://rpc1.example.com') return failures[started++]!.promise;
      return Promise.resolve(rpcUrl);
    };

    const a = pool.withFailover(operation);
    const b = pool.withFailover(operation);
    failures[0]!.reject('fetch failed');
    failures[1]!.reject('fetch failed');

    await expect(a).resolves.toBe('https://rpc2.example.com');
    await expect(b).resolves.toBe('https://rpc2.example.com');
    expect(pool.getActiveRpcUrl()).toBe('https://rpc2.example.com');
    expect(calls).not.toContain('https://rpc3.example.com');
  });
});

describe('#383 LedgerWalletAdapter network passphrase check', () => {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
  const transaction = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
    .setTimeout(0)
    .build();

  async function connectedAdapter() {
    const app: LedgerStellarApp = {
      getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: keypair.rawPublicKey() }),
      signTransaction: vi.fn().mockResolvedValue({ signature: keypair.sign(transaction.hash()) }),
    };
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();
    return { adapter, app };
  }

  it('signs when the passphrase matches the configured network', async () => {
    const { adapter } = await connectedAdapter();
    const signed = await adapter.signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET });
    expect(TransactionBuilder.fromXDR(signed, Networks.TESTNET).signatures).toHaveLength(1);
  });

  it('throws WalletNetworkMismatchError when the passphrase differs', async () => {
    const { adapter, app } = await connectedAdapter();
    await expect(
      adapter.signTransaction(transaction.toXDR(), { networkPassphrase: Networks.PUBLIC }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    expect(app.signTransaction).not.toHaveBeenCalled();
  });
});
