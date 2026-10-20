import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  Beneficiary,
  CreateWillParams,
  PaginatedWillsResult,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from '../src/types';
import { WillStatus } from '../src/types';
import {
  calculateShares,
  hasDuplicateBeneficiaries,
  tagOnChainOrder,
  validateBeneficiaries,
  validateGuardians,
} from '../src/utils';

const BENEFICIARY = 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG';

function makeWill(): Will {
  return {
    id: '1',
    owner: 'GOWNER',
    token: 'CTOKEN',
    balance: '1000',
    beneficiaries: [{ address: BENEFICIARY, percentage: 100 }],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    lastCheckin: new Date(0),
    triggerTime: null,
    status: WillStatus.Active,
    guardians: [],
    guardianVotes: 0,
  };
}

// These assignments are type errors under `tsc --noEmit` (strict mode). Each
// `@ts-expect-error` fails the typecheck if the field ever becomes writable.
function assertReadonlyAtCompileTime(
  will: Will,
  beneficiary: Beneficiary,
  create: CreateWillParams,
  update: UpdateBeneficiariesParams,
  page: PaginatedWillsResult,
  event: SoroWillEvent,
): void {
  // @ts-expect-error -- Will.id is readonly
  will.id = '2';
  // @ts-expect-error -- Will.balance is readonly
  will.balance = '0';
  // @ts-expect-error -- Will.status is readonly
  will.status = WillStatus.Released;
  // @ts-expect-error -- Will.beneficiaries is a readonly array
  will.beneficiaries.push(beneficiary);
  // @ts-expect-error -- Will.guardians is a readonly array
  will.guardians.push('GGUARD');
  // @ts-expect-error -- Beneficiary.percentage is readonly
  beneficiary.percentage = 50;
  // @ts-expect-error -- Beneficiary.address is readonly
  beneficiary.address = 'GOTHER';
  // @ts-expect-error -- CreateWillParams.amount is readonly
  create.amount = '0';
  // @ts-expect-error -- CreateWillParams.guardians is a readonly array
  create.guardians.push('GGUARD');
  // @ts-expect-error -- UpdateBeneficiariesParams.willId is readonly
  update.willId = '2';
  // @ts-expect-error -- PaginatedWillsResult.nextCursor is readonly
  page.nextCursor = null;
  // @ts-expect-error -- SoroWillEvent.txHash is readonly
  event.txHash = null;
}

describe('Issue #578: type definitions use readonly for immutable fields', () => {
  it('marks Will array fields as readonly arrays', () => {
    expectTypeOf<Will['beneficiaries']>().toEqualTypeOf<readonly Beneficiary[]>();
    expectTypeOf<Will['guardians']>().toEqualTypeOf<readonly string[]>();
    expectTypeOf<CreateWillParams['beneficiaries']>().toEqualTypeOf<readonly Beneficiary[]>();
    expectTypeOf<SoroWillEvent['topics']>().toEqualTypeOf<readonly unknown[]>();
  });

  it('keeps the compile-time readonly assertions referenced', () => {
    expect(typeof assertReadonlyAtCompileTime).toBe('function');
  });

  it('accepts readonly arrays in utility helpers', () => {
    const will = makeWill();
    const beneficiaries: readonly Beneficiary[] = will.beneficiaries;
    const guardians: readonly string[] = will.guardians;

    expect(validateBeneficiaries(beneficiaries)).toBe(true);
    expect(hasDuplicateBeneficiaries(beneficiaries)).toBe(false);
    expect(validateGuardians(guardians)).toBe(true);
    expect(calculateShares(will.balance, beneficiaries)).toEqual([
      { address: BENEFICIARY, share: '1000' },
    ]);
    expect(tagOnChainOrder(beneficiaries)).toEqual([
      { address: BENEFICIARY, percentage: 100, onChainIndex: 0 },
    ]);
  });

  it('still accepts plain mutable arrays where readonly arrays are expected', () => {
    const mutable: Beneficiary[] = [{ address: BENEFICIARY, percentage: 100 }];
    const params: CreateWillParams = {
      token: 'CTOKEN',
      amount: '1',
      beneficiaries: mutable,
      checkinPeriodDays: 90,
      gracePeriodDays: 7,
      guardians: [],
    };

    expect(params.beneficiaries).toBe(mutable);
  });
});
