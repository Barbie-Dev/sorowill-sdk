/**
 * Issue #3: Verify that the `nextDeadline` returned by `checkIn` matches what
 * a fresh `getWill` read would compute immediately after the transaction lands.
 *
 * The check-in method returns:
 *   nextDeadline = new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000)
 *
 * where `createdAt` is the confirmed ledger close time from the transaction
 * and `checkinPeriodDays` comes from a getWill() call made before the tx.
 *
 * After the tx, the contract updates `last_checkin` to the same ledger close
 * time. So a fresh getWill() after checkIn should show:
 *   lastCheckin = new Date(createdAt * 1000)
 *
 * which means:
 *   lastCheckin.getTime() + checkinPeriodDays * 86_400 * 1000 === nextDeadline.getTime()
 */

import { Account, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import { SoroWillClient, type SoroWillRpcServer } from '../src/SoroWillClient';
import { WillNotFoundError } from '../src/errors';
import { WillStatus } from '../src/types';

const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VOID_SCVAL = xdr.ScVal.scvVoid();

/** Ledger close time the mock transaction will be confirmed at. */
const CHECKIN_LEDGER_TIME = 1_710_000_000; // arbitrary Unix timestamp (seconds)
const CHECKIN_PERIOD_DAYS = 90;

/**
 * Build a raw will shape whose `last_checkin` matches the confirmed ledger
 * close time — simulating the on-chain state immediately after a check_in.
 */
function makePostCheckinRawWill() {
  return {
    id: 1n,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: BigInt(CHECKIN_PERIOD_DAYS),
    grace_period_days: 7n,
    // After checkIn the contract sets last_checkin to the ledger close time.
    last_checkin: BigInt(CHECKIN_LEDGER_TIME),
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };
}

/**
 * Build a raw will shape for the *pre-checkIn* getWill call. The checkin
 * period must be the same so the SDK can read it to compute the deadline.
 */
function makePreCheckinRawWill() {
  return {
    ...makePostCheckinRawWill(),
    // The last_checkin before the tx is some earlier time — doesn't matter
    // for this test, only checkin_period_days is used by checkIn().
    last_checkin: BigInt(CHECKIN_LEDGER_TIME - CHECKIN_PERIOD_DAYS * 86_400),
  };
}

function createSpec(willResults: unknown[]) {
  let callIndex = 0;
  return {
    funcArgsToScVals(_method: string, _args: Record<string, unknown>): xdr.ScVal[] {
      return [];
    },
    funcResToNative(method: string, _value: xdr.ScVal): unknown {
      // The spec is called for get_will (read simulation results)
      // and never for check_in (which returns void).
      if (method === 'get_will') {
        return willResults[callIndex++];
      }
      return undefined;
    },
  };
}

function createRpcServer(): SoroWillRpcServer {
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
      return { status: 'PENDING', hash: 'checkin_tx_hash' } as never;
    },
    async pollTransaction() {
      // The transaction lands at CHECKIN_LEDGER_TIME.
      return {
        status: 'SUCCESS',
        createdAt: CHECKIN_LEDGER_TIME,
        returnValue: VOID_SCVAL,
      } as never;
    },
  };
}

describe('checkIn nextDeadline consistency with getWill', () => {
  it('nextDeadline from checkIn matches lastCheckin + checkinPeriodDays from a fresh getWill', async () => {
    // The spec will serve the pre-checkin will for the SDK's internal getWill()
    // call (needed to read checkinPeriodDays), then serve the post-checkin will
    // for the caller's subsequent getWill() call.
    const spec = createSpec([makePreCheckinRawWill(), makePostCheckinRawWill()]);

    const wallet = {
      async isConnected() { return true; },
      async connect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async reconnect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async disconnect() {},
      async getPublicKey() { return TEST_ACCOUNT; },
      async signTransaction(xdrStr: string) { return xdrStr; },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet,
      readCache: false,
      spec,
      rpcServer: createRpcServer(),
    });

    // Perform the check-in.
    const { txHash, nextDeadline } = await client.checkIn('1');
    expect(txHash).toBe('checkin_tx_hash');

    // Read the will's fresh state immediately after.
    const freshWill = await client.getWill('1');

    // The contract sets last_checkin = ledger close time after checkIn.
    expect(freshWill.lastCheckin.getTime()).toBe(CHECKIN_LEDGER_TIME * 1000);

    // The deadline reported by checkIn must equal lastCheckin + the check-in period.
    const expectedDeadline = new Date(
      freshWill.lastCheckin.getTime() + freshWill.checkinPeriodDays * 86_400 * 1000,
    );

    expect(nextDeadline.getTime()).toBe(expectedDeadline.getTime());
  });

  it('nextDeadline uses the transaction ledger close time, not wall-clock time', async () => {
    // Confirm that the deadline is anchored to the ledger close time even when
    // there is a gap between submission and confirmation.
    const spec = createSpec([makePreCheckinRawWill()]);

    const wallet = {
      async isConnected() { return true; },
      async connect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async reconnect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async disconnect() {},
      async getPublicKey() { return TEST_ACCOUNT; },
      async signTransaction(xdrStr: string) { return xdrStr; },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet,
      readCache: false,
      spec,
      rpcServer: createRpcServer(),
    });

    const { nextDeadline } = await client.checkIn('1');

    // The deadline must be exactly CHECKIN_LEDGER_TIME + 90 days (in ms).
    const expectedMs = (CHECKIN_LEDGER_TIME + CHECKIN_PERIOD_DAYS * 86_400) * 1000;
    expect(nextDeadline.getTime()).toBe(expectedMs);
  });

  it('throws WillNotFoundError when the will does not exist', async () => {
    // createRpcServer returns a successful simulation; override to return a
    // WillNotFound contract error (code 1) for the getWill read.
    const failingRpcServer: SoroWillRpcServer = {
      ...createRpcServer(),
      async simulateTransaction() {
        return { error: 'Error(Contract, #1)' } as never;
      },
    };

    const wallet = {
      async isConnected() { return true; },
      async connect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async reconnect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async disconnect() {},
      async getPublicKey() { return TEST_ACCOUNT; },
      async signTransaction(xdrStr: string) { return xdrStr; },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet,
      readCache: false,
      spec: createSpec([]),
      rpcServer: failingRpcServer,
    });

    await expect(client.checkIn('999')).rejects.toBeInstanceOf(WillNotFoundError);
  });

  it('skips the existence pre-check when skipExistenceCheck is true', async () => {
    const spec = createSpec([]); // getWill is never called

    const wallet = {
      async isConnected() { return true; },
      async connect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async reconnect() { return { publicKey: TEST_ACCOUNT, network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' }; },
      async disconnect() {},
      async getPublicKey() { return TEST_ACCOUNT; },
      async signTransaction(xdrStr: string) { return xdrStr; },
    };

    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet,
      readCache: false,
      spec,
      rpcServer: createRpcServer(),
    });

    // With skipExistenceCheck, getWill is not called, so even a non-existent
    // will passes through to the invoke step.
    const { txHash } = await client.checkIn('999', { skipExistenceCheck: true });
    expect(txHash).toBe('checkin_tx_hash');
  });
});
