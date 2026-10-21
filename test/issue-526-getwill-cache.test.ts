/**
 * Tests for issue #526: SoroWillClient.getWill doesn't cache results or
 * document expected call frequency.
 *
 * The underlying caching was already wired to the shared ReadCache; this
 * file locks in the acceptance criteria:
 *   - results are cached by default,
 *   - the cache TTL is configurable,
 *   - tests verify caching (this file).
 */

import { describe, expect, it } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillStatus } from '../src/types';

const VOID_SCVAL = xdr.ScVal.scvVoid();
const CONTRACT_ID = 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR';

function makeRawWill(id: bigint, balance: bigint) {
  return {
    id,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

interface Harness {
  client: SoroWillClient;
  getSimulateCalls(): number;
}

function createHarness(extraOptions: Record<string, unknown> = {}): Harness {
  let simulateCalls = 0;
  const rpcServer: SoroWillRpcServer = {
    async getContractWasmByContractId(): Promise<Uint8Array> {
      return new Uint8Array();
    },
    async simulateTransaction() {
      simulateCalls += 1;
      return { result: { retval: VOID_SCVAL } } as never;
    },
    // The remaining methods are unused by read-only getWill calls but are
    // required by the SoroWillRpcServer interface.
    async getAccount() {
      throw new Error('not used by getWill');
    },
    async prepareTransaction() {
      throw new Error('not used by getWill');
    },
    async sendTransaction() {
      throw new Error('not used by getWill');
    },
    async pollTransaction() {
      throw new Error('not used by getWill');
    },
  };

  const spec = {
    funcArgsToScVals(): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string, _value: xdr.ScVal): unknown {
      if (method === 'get_will') {
        return makeRawWill(1n, 1_000_000n);
      }
      return undefined;
    },
  };

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    spec,
    rpcServer,
    ...extraOptions,
  });

  return { client, getSimulateCalls: () => simulateCalls };
}

describe('SoroWillClient.getWill caching (#526)', () => {
  it('caches results by default — repeated calls do not hit RPC again', async () => {
    const { client, getSimulateCalls } = createHarness();

    const first = await client.getWill('1');
    expect(getSimulateCalls()).toBe(1);

    const second = await client.getWill('1');
    expect(getSimulateCalls()).toBe(1); // served from cache

    expect(second.id).toBe(first.id);
    expect(second.balance).toBe(first.balance);
  });

  it('caches per will id — different wills are fetched separately', async () => {
    const { client, getSimulateCalls } = createHarness();

    await client.getWill('1');
    await client.getWill('2');
    expect(getSimulateCalls()).toBe(2);

    // Both remain cached.
    await client.getWill('1');
    await client.getWill('2');
    expect(getSimulateCalls()).toBe(2);
  });

  it('serves defensive clones from the cache — mutating a result does not poison it', async () => {
    const { client } = createHarness();

    const first = await client.getWill('1');
    const originalBalance = first.balance;
    first.balance = '999999999';

    const second = await client.getWill('1');
    expect(second.balance).toBe(originalBalance);
  });

  it('honours a configurable cache TTL — entries are refetched once expired', async () => {
    let currentTime = 1_000_000;
    const { client, getSimulateCalls } = createHarness({
      readCache: { ttlMs: 5_000, now: () => currentTime },
    });

    await client.getWill('1');
    expect(getSimulateCalls()).toBe(1);

    // Still within the TTL — cached.
    currentTime += 4_000;
    await client.getWill('1');
    expect(getSimulateCalls()).toBe(1);

    // Past the TTL — refetched from RPC.
    currentTime += 2_000;
    await client.getWill('1');
    expect(getSimulateCalls()).toBe(2);
  });

  it('readCache: false bypasses the cache entirely', async () => {
    const { client, getSimulateCalls } = createHarness({ readCache: false });

    await client.getWill('1');
    await client.getWill('1');
    expect(getSimulateCalls()).toBe(2);
  });
});
