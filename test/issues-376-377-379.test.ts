import { describe, expect, it, vi } from 'vitest';
import {
  Account,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import {
  BeneficiaryValidationError,
  SoroWillClient,
  WillStatus,
  hasDuplicateBeneficiaries,
  validateBeneficiaries,
} from '../src';
import { ReadCache } from '../src/cache';
import { assertPreparedTransactionMatchesIntendedOperation } from '../src/txValidation';

describe('#376 duplicate beneficiaries', () => {
  const a = Keypair.random().publicKey();
  const b = Keypair.random().publicKey();

  it('validateBeneficiaries rejects duplicate addresses', () => {
    const list = [
      { address: a, percentage: 50 },
      { address: a, percentage: 50 },
    ];
    expect(hasDuplicateBeneficiaries(list)).toBe(true);
    expect(validateBeneficiaries(list)).toBe(false);
  });

  it('detects duplicates that differ only in letter case', () => {
    const list = [
      { address: a, percentage: 50 },
      { address: a.toLowerCase(), percentage: 50 },
    ];
    expect(hasDuplicateBeneficiaries(list)).toBe(true);
    expect(validateBeneficiaries(list)).toBe(false);
  });

  it('accepts distinct addresses', () => {
    const list = [
      { address: a, percentage: 50 },
      { address: b, percentage: 50 },
    ];
    expect(hasDuplicateBeneficiaries(list)).toBe(false);
    expect(validateBeneficiaries(list)).toBe(true);
  });

  it('createWill and updateBeneficiaries throw a duplicate-specific error', async () => {
    const client: SoroWillClient = Object.create(SoroWillClient.prototype);
    const beneficiaries = [
      { address: a, percentage: 50 },
      { address: a, percentage: 50 },
    ];
    await expect(
      client.createWill({ beneficiaries, guardians: [] } as never),
    ).rejects.toThrow(new BeneficiaryValidationError('Invalid beneficiaries: duplicate beneficiary addresses are not allowed.'));
    await expect(
      client.updateBeneficiaries({ willId: '1', beneficiaries }),
    ).rejects.toThrow(/duplicate beneficiary/);
  });
});

describe('#377 getWill cache key uses the canonical will id', () => {
  const rawWill = {
    id: 7n,
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 10_000 }],
    checkin_period_days: 30n,
    grace_period_days: 7n,
    last_checkin: 1_700_000_000n,
    trigger_time: undefined,
    status: WillStatus.Active,
    guardians: [],
    guardian_votes: 0,
  };

  it('shares one cache entry for 7 and 007 and invalidates both by will 7', async () => {
    const client = Object.create(SoroWillClient.prototype) as SoroWillClient;
    const readCache = new ReadCache();
    const read = vi.fn(async () => rawWill);
    Object.assign(client, { readCache, read });

    await client.getWill('7');
    await client.getWill('007');
    expect(read).toHaveBeenCalledTimes(1);

    await readCache.invalidateByWillId('7');
    await client.getWill('007');
    await client.getWill('7');
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe('#379 invoke-contract target comparison', () => {
  const account = () => new Account(Keypair.random().publicKey(), '1');
  const contractA = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
  const contractB = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';

  function buildTx(source: Account, contractId: string, fn: string) {
    return new TransactionBuilder(source, { fee: '1000', networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(contractId).call(fn, xdr.ScVal.scvU64(xdr.Uint64.fromString('1'))))
      .setTimeout(30)
      .build();
  }

  function check(intended: string, prepared: string) {
    return () =>
      assertPreparedTransactionMatchesIntendedOperation({
        intendedTransactionXdr: intended,
        preparedTransactionXdr: prepared,
        networkPassphrase: Networks.TESTNET,
        context: 'invoke_contract',
      });
  }

  it('rejects the same args on a different contract address', () => {
    const src = account();
    const intended = buildTx(src, contractA, 'get_will').toXDR();
    const prepared = buildTx(src, contractB, 'get_will').toXDR();
    expect(check(intended, prepared)).toThrow('did not match the intended operation');
  });

  it('rejects the same args on a different function name', () => {
    const src = account();
    const intended = buildTx(src, contractA, 'get_will').toXDR();
    const prepared = buildTx(src, contractA, 'cancel_will').toXDR();
    expect(check(intended, prepared)).toThrow('did not match the intended operation');
  });

  it('accepts a matching address, function name and args', () => {
    const src = account();
    const intended = buildTx(src, contractA, 'get_will').toXDR();
    const prepared = buildTx(src, contractA, 'get_will').toXDR();
    expect(check(intended, prepared)).not.toThrow();
  });
});
