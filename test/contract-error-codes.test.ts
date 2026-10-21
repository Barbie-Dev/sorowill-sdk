import { describe, expect, it, vi } from 'vitest';
import {
  AlreadyClaimedError,
  BeneficiaryNotFoundError,
  ConfirmationWindowExpiredError,
  DuplicateBeneficiaryError,
  DuplicateGuardianError,
  FixedAmountExceedsBalanceError,
  GuardianCooldownActiveError,
  InsufficientBalanceError,
  InvalidGuardianThresholdError,
  InvalidPercentageError,
  InvalidPeriodError,
  InvalidPreimageError,
  InvalidSplitError,
  InvalidTokenError,
  KeeperBountyExceedsMaxError,
  MergeWouldExceedLimitsError,
  NotSameOwnerError,
  OwnerCannotBeGuardianError,
  SameWillIdError,
  SoroWillError,
  TooManyIdsError,
  TooManyWillsError,
  UnknownContractErrorCodeError,
  WillContractError,
  WillNotBothActiveError,
  WillNotConfirmedError,
  WillNotReleasedError,
  WillNotSettledError,
  mapContractError,
} from '../src/errors';
import { WillErrorCode } from '../src/types';

// === Representative sample of the codes added for the full 1-37 WillError enum

const SAMPLE: Array<[number, new (options?: ErrorOptions) => WillContractError, string]> = [
  [13, WillNotSettledError, 'WillNotSettledError'],
  [14, WillNotBothActiveError, 'WillNotBothActiveError'],
  [15, SameWillIdError, 'SameWillIdError'],
  [16, MergeWouldExceedLimitsError, 'MergeWouldExceedLimitsError'],
  [17, OwnerCannotBeGuardianError, 'OwnerCannotBeGuardianError'],
  [18, BeneficiaryNotFoundError, 'BeneficiaryNotFoundError'],
  [19, KeeperBountyExceedsMaxError, 'KeeperBountyExceedsMaxError'],
  [20, InvalidGuardianThresholdError, 'InvalidGuardianThresholdError'],
  [21, FixedAmountExceedsBalanceError, 'FixedAmountExceedsBalanceError'],
  [22, InvalidPercentageError, 'InvalidPercentageError'],
  [23, WillNotReleasedError, 'WillNotReleasedError'],
  [24, NotSameOwnerError, 'NotSameOwnerError'],
  [25, InvalidPeriodError, 'InvalidPeriodError'],
  [26, DuplicateGuardianError, 'DuplicateGuardianError'],
  [27, GuardianCooldownActiveError, 'GuardianCooldownActiveError'],
  [28, InvalidTokenError, 'InvalidTokenError'],
  [29, DuplicateBeneficiaryError, 'DuplicateBeneficiaryError'],
  [30, WillNotConfirmedError, 'WillNotConfirmedError'],
  [31, ConfirmationWindowExpiredError, 'ConfirmationWindowExpiredError'],
  [32, TooManyIdsError, 'TooManyIdsError'],
  [33, InsufficientBalanceError, 'InsufficientBalanceError'],
  [34, InvalidSplitError, 'InvalidSplitError'],
  [35, InvalidPreimageError, 'InvalidPreimageError'],
  [36, AlreadyClaimedError, 'AlreadyClaimedError'],
  [37, TooManyWillsError, 'TooManyWillsError'],
];

describe('mapContractError — contract error codes 13-37', () => {
  it.each(SAMPLE)('maps Error(Contract, #%i) to its typed class', (code, ErrorClass, name) => {
    const mapped = mapContractError(new Error(`Error(Contract, #${code})`));

    expect(mapped).toBeInstanceOf(ErrorClass);
    expect(mapped).toBeInstanceOf(WillContractError);
    expect((mapped as WillContractError).code).toBe(code);
    expect(mapped.name).toBe(name);
  });

  it('never falls through to a generic SoroWillError for any code in 13-37', () => {
    for (let code = 13; code <= 37; code += 1) {
      const mapped = mapContractError(new Error(`Error(Contract, #${code})`));
      expect(mapped).toBeInstanceOf(WillContractError);
      expect((mapped as WillContractError).code).toBe(code);
    }
  });

  it('keeps WillErrorCode enum values aligned with the mapped classes', () => {
    for (const [code, , name] of SAMPLE) {
      const member = name.replace(/Error$/, '');
      expect(WillErrorCode[member as keyof typeof WillErrorCode]).toBe(code);
    }
  });
});

describe('mapContractError — unknown contract error codes', () => {
  it('returns UnknownContractErrorCodeError for an unregistered numeric code', () => {
    const mapped = mapContractError(new Error('Error(Contract, #99)'));
    expect(mapped).toBeInstanceOf(UnknownContractErrorCodeError);
    // UnknownContractErrorCodeError is a generic SoroWillError so callers can
    // always catch a well-known SDK base class for unregistered codes.
    expect(mapped).toBeInstanceOf(SoroWillError);
    expect((mapped as UnknownContractErrorCodeError).code).toBe(99);
  });

  it('logs a warning for unknown error codes', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const mapped = mapContractError(new Error('Error(Contract, #42)'));
      expect(mapped).toBeInstanceOf(UnknownContractErrorCodeError);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('returns the original error when no numeric code is found in the text', () => {
    const original = new Error('Some random contract failure without a code');
    const mapped = mapContractError(original);
    expect(mapped).toBe(original);
  });
});
