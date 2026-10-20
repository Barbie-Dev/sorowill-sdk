import { describe, expect, it, vi } from 'vitest';
import { xdr } from '@stellar/stellar-sdk';
import { SoroWillClient, SoroWillInvalidIdError } from '../src/index';

const CONTRACT_ID = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';

function rawWill(id: bigint) {
  return {
    id,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: 'Active',
    guardians: [],
    guardian_votes: 0,
  };
}

function makeClient() {
  const calls: { method: string; args: Record<string, unknown> }[] = [];
  let lastArgs: Record<string, unknown> = {};
  let lastMethod = '';

  const fakeSpec = {
    funcArgsToScVals: (method: string, args: Record<string, unknown>) => {
      lastMethod = method;
      lastArgs = args;
      calls.push({ method, args });
      return [] as xdr.ScVal[];
    },
    funcResToNative: () => {
      if (lastMethod === 'get_wills') {
        return (lastArgs.will_ids as bigint[]).map(rawWill);
      }
      return rawWill(lastArgs.will_id as bigint);
    },
  };

  const simulateTransaction = vi.fn(async () => ({ result: { retval: {} } }));
  const fakeServer = {
    simulateTransaction,
    getLatestLedger: async () => ({ sequence: '123' }),
  };

  const client = new SoroWillClient({
    network: 'testnet',
    contractId: CONTRACT_ID,
    rpcServer: fakeServer as any,
    spec: fakeSpec as any,
  });

  return { client, calls, simulateTransaction };
}

describe('Issue #575: batch read operations', () => {
  it('fetches multiple wills with a single RPC call', async () => {
    const { client, calls, simulateTransaction } = makeClient();

    const wills = await client.getWills(['1', '2', '3']);

    expect(wills.map((w) => w.id)).toEqual(['1', '2', '3']);
    expect(simulateTransaction).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('get_wills');
    expect(calls[0].args.will_ids).toEqual([1n, 2n, 3n]);
  });

  it('is more efficient than calling getWill per id', async () => {
    const batched = makeClient();
    await batched.client.getWills(['1', '2', '3', '4', '5']);

    const individual = makeClient();
    for (const id of ['1', '2', '3', '4', '5']) {
      await individual.client.getWill(id);
    }

    expect(batched.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(individual.simulateTransaction).toHaveBeenCalledTimes(5);
  });

  it('preserves input order and de-duplicates ids in the request', async () => {
    const { client, calls } = makeClient();

    const wills = await client.getWills(['3', '1', '3']);

    expect(wills.map((w) => w.id)).toEqual(['3', '1', '3']);
    expect(calls[0].args.will_ids).toEqual([3n, 1n]);
    expect(wills[0]).not.toBe(wills[2]);
  });

  it('returns an empty list without an RPC call for an empty input', async () => {
    const { client, simulateTransaction } = makeClient();

    await expect(client.getWills([])).resolves.toEqual([]);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });

  it('rejects malformed ids before any RPC call', async () => {
    const { client, simulateTransaction } = makeClient();

    await expect(client.getWills(['1', 'abc'])).rejects.toBeInstanceOf(SoroWillInvalidIdError);
    expect(simulateTransaction).not.toHaveBeenCalled();
  });
});
