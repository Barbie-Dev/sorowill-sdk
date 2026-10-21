/**
 * Tests for issue #523: InFlightTracker doesn't prevent duplicate in-flight
 * requests for the same operation — multiple calls to checkIn with the same
 * willId can issue duplicate transactions.
 *
 * Fix: InFlightTracker.trackExclusive() rejects a duplicate (willId, method)
 * with a DuplicateOperationError instead of coalescing it, and
 * SoroWillClient routes `check_in` invocations through it so a second
 * concurrent checkIn can never submit a second transaction on-chain.
 */

import { describe, expect, it } from 'vitest';
import { Account, xdr } from '@stellar/stellar-sdk';

import { InFlightTracker } from '../src/inFlightTracker';
import { DuplicateOperationError } from '../src/errors';
import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

// ─── InFlightTracker.trackExclusive unit tests ───────────────────────────────

describe('InFlightTracker.trackExclusive (#523)', () => {
  it('runs the operation and resolves normally when nothing is in flight', async () => {
    const tracker = new InFlightTracker();
    const result = await tracker.trackExclusive('1', 'check_in', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('rejects a duplicate operation with DuplicateOperationError while one is in flight', async () => {
    const tracker = new InFlightTracker();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tracker.trackExclusive('1', 'check_in', async () => {
      calls += 1;
      await gate;
      return 'first';
    });

    const second = tracker.trackExclusive('1', 'check_in', async () => {
      calls += 1;
      return 'second';
    });

    await expect(second).rejects.toBeInstanceOf(DuplicateOperationError);
    await expect(second).rejects.toMatchObject({ willId: '1', method: 'check_in' });

    release();
    await expect(first).resolves.toBe('first');
    // The duplicate operation must never have been invoked.
    expect(calls).toBe(1);
  });

  it('does not affect operations for different willIds or different methods', async () => {
    const tracker = new InFlightTracker();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = tracker.trackExclusive('1', 'check_in', async () => {
      await gate;
      return 'a';
    });

    // Different willId, same method — allowed.
    const otherWill = tracker.trackExclusive('2', 'check_in', async () => 'b');
    // Same willId, different method — allowed.
    const otherMethod = tracker.trackExclusive('1', 'cancel_will', async () => 'c');

    await expect(otherWill).resolves.toBe('b');
    await expect(otherMethod).resolves.toBe('c');

    release();
    await expect(first).resolves.toBe('a');
  });

  it('allows a fresh operation once the previous one has settled', async () => {
    const tracker = new InFlightTracker();

    const first = tracker.trackExclusive('1', 'check_in', async () => 'first');
    await expect(first).resolves.toBe('first');

    const second = tracker.trackExclusive('1', 'check_in', async () => 'second');
    await expect(second).resolves.toBe('second');
  });

  it('evicts expired entries so a stale operation cannot block retries forever', async () => {
    // ttlMs = 10ms so the in-flight entry expires quickly.
    const tracker = new InFlightTracker('scope', 10);

    tracker.trackExclusive('1', 'check_in', () => new Promise(() => {}));
    expect(tracker.isInFlight('1', 'check_in')).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 25));

    // The expired entry is evicted, so a retry goes through instead of
    // being rejected as a duplicate.
    await expect(
      tracker.trackExclusive('1', 'check_in', async () => 'retry'),
    ).resolves.toBe('retry');
  });

  it('does not reject when the same operation is tracked via the coalescing track()', async () => {
    const tracker = new InFlightTracker();
    let calls = 0;
    const op = async () => {
      calls += 1;
      return 'result';
    };

    // track() coalesces — both callers share one operation (pre-existing
    // behaviour that trackExclusive deliberately changes only for itself).
    const [a, b] = await Promise.all([
      tracker.track('1', 'check_in', op),
      tracker.track('1', 'check_in', op),
    ]);
    expect(a).toBe('result');
    expect(b).toBe('result');
    expect(calls).toBe(1);
  });
});

// ─── SoroWillClient.checkIn end-to-end dedup ─────────────────────────────────

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();
const LEDGER_TIME = 1_710_000_000;

function makeRawWill() {
  return {
    id: 1n,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: BigInt(LEDGER_TIME - 90 * 86_400),
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

function createSpec() {
  return {
    funcArgsToScVals(): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string): unknown {
      if (method === 'get_will') {
        return makeRawWill();
      }
      return undefined;
    },
  };
}

function createCountingRpcServer(counters: { sendTransaction: number }): SoroWillRpcServer {
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
      counters.sendTransaction += 1;
      return { status: 'PENDING', hash: `checkin_tx_hash_${counters.sendTransaction}` } as never;
    },
    async pollTransaction() {
      return {
        status: 'SUCCESS',
        createdAt: LEDGER_TIME,
        returnValue: VOID_SCVAL,
      } as never;
    },
  };
}

function createClient(counters: { sendTransaction: number }): SoroWillClient {
  const wallet = {
    async isConnected() {
      return true;
    },
    async connect() {
      return {
        publicKey: TEST_ACCOUNT,
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
      };
    },
    async reconnect() {
      return {
        publicKey: TEST_ACCOUNT,
        network: 'testnet',
        networkPassphrase: 'Test SDF Network ; September 2015',
      };
    },
    async disconnect() {},
    async getPublicKey() {
      return TEST_ACCOUNT;
    },
    async signTransaction(xdrStr: string) {
      return xdrStr;
    },
  };

  return new SoroWillClient({
    network: 'testnet',
    contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    wallet,
    readCache: false,
    spec: createSpec(),
    rpcServer: createCountingRpcServer(counters),
  });
}

describe('SoroWillClient.checkIn duplicate rejection (#523)', () => {
  it('rejects a concurrent duplicate checkIn for the same willId and submits only one transaction', async () => {
    const counters = { sendTransaction: 0 };
    const client = createClient(counters);

    const [first, second] = await Promise.allSettled([
      client.checkIn('1'),
      client.checkIn('1'),
    ]);

    const fulfilled = [first, second].filter(
      (r): r is PromiseFulfilledResult<{ txHash: string; nextDeadline: Date }> =>
        r.status === 'fulfilled',
    );
    const rejected = [first, second].filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value.txHash).toBe('checkin_tx_hash_1');
    expect(rejected[0]!.reason).toBeInstanceOf(DuplicateOperationError);
    expect(rejected[0]!.reason).toMatchObject({ willId: '1', method: 'check_in' });

    // Only the original operation ever reached the network.
    expect(counters.sendTransaction).toBe(1);
  });

  it('allows a new checkIn after the previous one has settled', async () => {
    const counters = { sendTransaction: 0 };
    const client = createClient(counters);

    const first = await client.checkIn('1');
    expect(first.txHash).toBe('checkin_tx_hash_1');

    const second = await client.checkIn('1');
    expect(second.txHash).toBe('checkin_tx_hash_2');
    expect(counters.sendTransaction).toBe(2);
  });

  it('does not reject concurrent checkIns for different wills', async () => {
    const counters = { sendTransaction: 0 };
    const client = createClient(counters);

    const results = await Promise.allSettled([client.checkIn('1'), client.checkIn('2')]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(counters.sendTransaction).toBe(2);
  });
});
