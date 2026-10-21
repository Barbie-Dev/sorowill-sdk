import { StrKey } from '@stellar/stellar-sdk';

import { BeneficiaryValidationError } from './errors';
import type { Beneficiary, Will } from './types';
import { WillStatus } from './types';

/**
 * Default decimal precision assumed by {@link formatUSDC} and
 * {@link toStroops} when the caller does not supply an explicit `decimals`
 * value.
 *
 * **Assumption**: this default of 7 matches USDC-like tokens on Soroban,
 * which use 7 decimal places (classic Stellar asset precision). Canonical
 * USDC on Ethereum/Polygon uses 6 decimals; callers handling such tokens
 * must pass the token's actual `decimals` explicitly to avoid displaying
 * incorrect amounts.
 */
const USDC_DECIMALS = 7;

/**
 * Approximate Soroban ledger close time, in milliseconds. Matches the
 * default `defaultPollIntervalMs` used internally by `SoroWillClient` for
 * event subscriptions, so consumers polling `getWill` or transaction status
 * themselves don't each have to hardcode this magic number independently.
 */
export const SOROBAN_LEDGER_CLOSE_TIME_MS = 5_000;

/**
 * Generates a random nonce for transaction building.
 *
 * **Security assumption**: nonces MUST be unpredictable. An attacker who can
 * predict a nonce can preempt the transaction (e.g. by front-running it with
 * a colliding transaction ID). This function therefore uses the platform
 * CSPRNG (`crypto.getRandomValues`) rather than `Math.random()`, which is
 * seeded deterministically and trivially predictable.
 *
 * Returns a 32-character lowercase hex string (128 bits of entropy).
 */
export function generateRandomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Formats a base-unit token amount (e.g. contract-side `i128` stroops) as a
 * human-readable decimal string with thousands separators, e.g.
 * `formatUSDC(12345000000n) === "1,234.50"`.
 *
 * The result always has exactly two fractional digits. Sub-cent amounts are
 * rounded half up (away from zero for negative values), so
 * `formatUSDC(19_990_000n) === "2.00"` and `formatUSDC(19_949_999n) === "1.99"`.
 */
export function formatUSDC(stroops: bigint, decimals = USDC_DECIMALS): string {
  const negative = stroops < 0n;
  const absolute = negative ? -stroops : stroops;
  const base = 10n ** BigInt(decimals);
  let whole = absolute / base;
  let fraction = absolute % base;

  // Round to 2 decimal places (cents)
  if (decimals > 2) {
    const divisor = 10n ** BigInt(decimals - 2);
    const remainder = fraction % divisor;
    const halfDivisor = divisor / 2n;
    if (remainder >= halfDivisor) {
      fraction = fraction + (divisor - remainder);
      if (fraction >= base) {
        whole += 1n;
        fraction -= base;
      }
    } else {
      fraction = fraction - remainder;
    }
  }

  const wholeFormatted = whole.toLocaleString('en-US');

  if (decimals <= 0) {
    // When decimals <= 0, show .00 (cents format)
    return `${negative ? '-' : ''}${wholeFormatted}.00`;
  }

  const fractionPadded = fraction.toString().padStart(decimals, '0');
  let fractionFormatted = fractionPadded.replace(/0+$/, '');

  // Always show at least 2 decimal places
  if (fractionFormatted.length < 2) {
    fractionFormatted = fractionFormatted.padEnd(2, '0');
  }

  return fractionFormatted === ''
    ? `${negative ? '-' : ''}${wholeFormatted}.00`
    : `${negative ? '-' : ''}${wholeFormatted}.${fractionFormatted}`;
}

/**
 * Expands a number written in scientific notation (e.g. `"1e-8"`,
 * `"1.5e3"`, `"-2.5E-4"`) into its equivalent plain decimal string, so the
 * rest of {@link toStroops} can parse it with the same logic used for
 * standard decimal notation. Returns `null` when `value` is not valid
 * scientific notation.
 */
function expandScientificNotation(value: string): string | null {
  const match = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) {
    return null;
  }

  const [, sign, intPart, fracPart = '', expPart] = match;
  if (!intPart || !expPart) return null;
  const exponent = Number(expPart);
  const digits = intPart + fracPart;
  // Position of the decimal point relative to `digits` after applying the exponent.
  const pointPos = intPart.length + exponent;

  let expanded: string;
  if (pointPos <= 0) {
    expanded = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    expanded = `${digits}${'0'.repeat(pointPos - digits.length)}`;
  } else {
    expanded = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }

  return `${sign}${expanded}`;
}

/**
 * Parses a human-readable decimal USDC string (e.g. `"1234.50"` or
 * `"1,234.5"`) into base units (stroops), as a `bigint`.
 *
 * `decimals` is the token's on-chain decimal precision and defaults to
 * {@link USDC_DECIMALS} (6). Pass the token's actual `decimals` when it is
 * not 6 so the parsed base units match the token's scale.
 *
 * Scientific notation (e.g. `"1e-8"`) is expanded to standard decimal
 * notation before the `decimals` offset is applied, so
 * `toStroops("1e-8", 8) === 100000000n`.
 */
export function toStroops(usdc: string, decimals = USDC_DECIMALS): bigint {
  const cleaned = usdc.replace(/,/g, '').trim();
  const expanded = expandScientificNotation(cleaned) ?? cleaned;
  if (expanded === '' || !/^-?\d*\.?\d*$/.test(expanded) || expanded === '-' || expanded === '.') {
    throw new Error(`Invalid USDC amount: "${usdc}"`);
  }

  const negative = cleaned.startsWith('-');
  const unsigned = negative ? cleaned.slice(1) : cleaned;
  const [wholePart = '', rawFraction = ''] = unsigned.split('.');
  // Trailing zeros carry no precision, so "1.50" is valid even for 1-decimal tokens.
  const fractionPart = rawFraction.replace(/0+$/, '');
  if (fractionPart.length > decimals) {
    throw new Error(
      `Invalid USDC amount: "${usdc}" has more than ${decimals} fractional digits, which would silently lose precision.`,
    );
  }
  const paddedFraction = fractionPart.padEnd(decimals, '0');

  const whole = BigInt(wholePart === '' ? '0' : wholePart);
  const fraction = BigInt(paddedFraction === '' ? '0' : paddedFraction);
  const total = whole * (10n ** BigInt(decimals)) + fraction;

  return negative ? -total : total;
}

/**
 * Returns the number of seconds until `will`'s next check-in deadline.
 * Negative values mean the deadline has already passed.
 */
export function getTimeUntilCheckin(will: Will): number {
  const deadlineMs = will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400 * 1000;
  return Math.floor((deadlineMs - Date.now()) / 1000);
}

/** Returns whether `will`'s check-in deadline has already passed. */
export function isCheckinDue(will: Will): boolean {
  return getTimeUntilCheckin(will) <= 0;
}

/**
 * Splits `balance` (base units, as a decimal string) across `beneficiaries`
 * proportionally to their percentages, mirroring the on-chain distribution
 * logic exactly: integer division per beneficiary, with any rounding
 * remainder paid to the final beneficiary so the shares always sum to the
 * full balance.
 *
 * This function mirrors the Rust contract's `distribute()` function in the
 * SoroWill contracts repository:
 * https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/will/src/lib.rs
 * (see `fn distribute` — integer division with remainder assigned to the
 * last beneficiary). Keep this implementation in sync with any changes to
 * that contract function.
 *
 * `beneficiary.percentage` is the SDK's 0-100 value. The contract works in
 * basis points (`percentage * 100`) and divides by 10,000, which is
 * arithmetically identical to dividing by 100 here, so the split matches
 * on-chain distribution exactly.
 */
export function calculateShares(
  balance: string,
  beneficiaries: readonly Beneficiary[],
): Array<{ address: string; share: string }> {
  const total = BigInt(balance);
  let remaining = total;

  return beneficiaries.map((beneficiary, index) => {
    const isLast = index === beneficiaries.length - 1;
    const share = isLast
      ? remaining
      : (total * BigInt(beneficiary.percentage)) / 100n;
    remaining -= share;
    return { address: beneficiary.address, share: share.toString() };
  });
}

/**
 * Tags each beneficiary with its index in the on-chain order. Callers who
 * want to sort or filter beneficiaries for display (e.g. alphabetically)
 * can sort the tagged copy and still recover the original on-chain order
 * (by sorting on `onChainIndex`) before passing beneficiaries to
 * {@link calculateShares}, so the rounding remainder is attributed correctly.
 */
export function tagOnChainOrder(
  beneficiaries: readonly Beneficiary[],
): Array<Beneficiary & { onChainIndex: number }> {
  return beneficiaries.map((beneficiary, onChainIndex) => ({ ...beneficiary, onChainIndex }));
}

/** Formats a `Date` as a human-readable string, e.g. `"Jan 5, 2027, 3:45 PM"`. */
export function formatDeadline(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * Maximum number of beneficiaries the SoroWill contract allows per will.
 *
 * **IMPORTANT**: This value mirrors the `MAX_BENEFICIARIES` constant in the
 * contract's `contracts/will/src/lib.rs` and must be kept in sync manually until the
 * contracts repo ships automated spec-drift tooling (issue #122).
 */
export const MAX_BENEFICIARIES = 10;

/**
 * Maximum number of guardians the SoroWill contract allows per will.
 *
 * Matches `MAX_GUARDIANS` (value `3`) in the contract's
 * `contracts/will/src/lib.rs` — see
 * {@link https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/will/src/lib.rs}
 * Kept in sync manually until the contracts repo ships automated spec-drift
 * tooling (issue #122).
 */
export const MAX_GUARDIANS = 3;

/**
 * Tolerance for floating-point percentage sums. Because binary floating-point
 * arithmetic can produce results like `99.99999999999999` instead of `100`,
 * we treat the sum as valid when it is within `EPSILON` of 100.
 */
export const PERCENTAGE_SUM_EPSILON = 1e-9;

/**
 * Validates that a beneficiary list is well-formed: non-empty, at most
 * {@link MAX_BENEFICIARIES} entries, no duplicate addresses (compared
 * case-insensitively), every percentage is a positive number, and
 * percentages sum to 100 (within {@link PERCENTAGE_SUM_EPSILON} to tolerate
 * binary floating-point rounding).
 *
 * Percentages are on the SDK's 0-100 scale. `SoroWillClient` scales them to
 * the contract's basis points (summing to 10,000) when it submits a
 * transaction.
 *
 * @throws {BeneficiaryValidationError} When the list contains duplicate
 *   addresses — the message explicitly names the duplicated address so
 *   callers can surface a meaningful error to the user. All other validation
 *   failures (empty list, too many entries, bad percentages, wrong sum)
 *   return `false` as before.
 */
export function validateBeneficiaries(beneficiaries: readonly Beneficiary[]): boolean {
  if (beneficiaries.length === 0 || beneficiaries.length > MAX_BENEFICIARIES) {
    return false;
  }
  if (!beneficiaries.every((b) => StrKey.isValidEd25519PublicKey(b.address))) {
    return false;
  }
  if (!beneficiaries.every((b) => typeof b.percentage === 'number' && b.percentage > 0)) {
    return false;
  }

  // Check for duplicate addresses — must come before the percentage sum check
  // so the error message can name the offending address rather than just
  // reporting an invalid sum. Comparison is case-insensitive to match
  // `hasDuplicateBeneficiaries` and the contract's on-chain check.
  const seen = new Set<string>();
  for (const b of beneficiaries) {
    const normalized = b.address.toUpperCase();
    if (seen.has(normalized)) {
      throw new BeneficiaryValidationError(
        `Duplicate beneficiary address: "${b.address}" appears more than once. ` +
          'Each beneficiary must have a unique Stellar address.',
      );
    }
    seen.add(normalized);
  }

  const sum = beneficiaries.reduce((acc, b) => acc + b.percentage, 0);
  return Math.abs(sum - 100) < PERCENTAGE_SUM_EPSILON;
}

/**
 * Returns whether two or more entries in `beneficiaries` share the same
 * address (compared case-insensitively), which the contract rejects with
 * `WillError::DuplicateBeneficiary`.
 */
export function hasDuplicateBeneficiaries(beneficiaries: readonly Beneficiary[]): boolean {
  const addresses = new Set(beneficiaries.map((b) => b.address.toUpperCase()));
  return addresses.size !== beneficiaries.length;
}

/** Returns whether `address` is one of `will`'s guardians. */
export function isGuardian(will: Will, address: string): boolean {
  return will.guardians.includes(address);
}

/** Returns whether `address` is one of `will`'s beneficiaries. */
export function isBeneficiary(will: Will, address: string): boolean {
  return will.beneficiaries.some((b) => b.address === address);
}

/**
 * Describes what the wallet at `connectedAddress` can currently do for
 * `will`, combining its status, owner, guardians, and beneficiaries with
 * the check-in deadline. Intended to drive which action buttons a UI shows.
 */
export interface NextActionableState {
  canCheckIn: boolean;
  canTrigger: boolean;
  canEmergencyCheckIn: boolean;
  canRelease: boolean;
  canCancel: boolean;
  canGuardianVote: boolean;
}

export interface NextActionableStateOptions {
  guardianAlreadyVoted?: boolean;
  now?: Date;
}

/**
 * Computes {@link NextActionableState} for `will` from the perspective of
 * `connectedAddress`. Only the owner may check in, cancel, or emergency
 * check in; triggering and releasing are permissionless once their
 * on-chain preconditions are met; and guardians may vote for 

/* … truncated 3004 chars — edit only what you need near the top … */

export function getNextActionableState(
  will: Will,
  connectedAddress: string,
  options: NextActionableStateOptions = {},
): NextActionableState {
  const isOwner = will.owner === connectedAddress;
  const isGuardian = will.guardians.includes(connectedAddress);
  const isActive = will.status === WillStatus.Active;
  const isTriggered = will.status === WillStatus.Triggered;

  const now = options.now?.getTime() ?? Date.now();

  // Compute grace period expiry from trigger time
  const isGracePeriodExpired = will.triggerTime !== null &&
    (will.triggerTime.getTime() + will.gracePeriodDays * 86_400_000) < now;

  // Compute check-in deadline from last check-in
  const nextCheckinDeadline = will.lastCheckin.getTime() + will.checkinPeriodDays * 86_400_000;
  const isCheckinOverdue = isActive && nextCheckinDeadline < now;
  
  return {
    canCheckIn: isOwner && isActive && !isCheckinOverdue,
    canTrigger: isCheckinOverdue && !isTriggered,
    canEmergencyCheckIn: isOwner && isTriggered && !isGracePeriodExpired,
    canRelease: isTriggered && isGracePeriodExpired,
    canCancel: isOwner && (isActive || isTriggered),
    canGuardianVote: isGuardian && isActive && !options.guardianAlreadyVoted,
  };
}

export function validateGuardians(
  guardians: readonly string[],
  ownerAddress?: string,
): boolean {
  if (!Array.isArray(guardians)) {
    return false;
  }
  if (guardians.length > MAX_GUARDIANS) {
    return false;
  }

  for (const guardian of guardians) {
    if (!StrKey.isValidEd25519PublicKey(guardian)) {
      return false;
    }
  }

  if (ownerAddress) {
    if (!StrKey.isValidEd25519PublicKey(ownerAddress)) {
      return false;
    }
    if (guardians.includes(ownerAddress)) {
      return false;
    }
  }

  const seen = new Set<string>();
  for (const guardian of guardians) {
    if (seen.has(guardian)) {
      return false;
    }
    seen.add(guardian);
  }

  return true;
}

export function formatTokenAmount(
  stroops: bigint | string | number,
  decimals: number = USDC_DECIMALS,
): string {
  const bigIntValue = typeof stroops === 'bigint' ? stroops : BigInt(stroops);
  return formatUSDC(bigIntValue, decimals);
}

/**
 * Recursively freezes `value` and all of its nested objects so that any
 * subsequent mutation attempt throws (in strict mode) or silently fails
 * (in sloppy mode).
 *
 * Use this to enforce immutability guarantees on SDK-returned objects so
 * callers cannot accidentally mutate internal SDK state by modifying a
 * returned `Will`, `Beneficiary`, or similar value object.
 *
 * Only plain objects, arrays, and `Date` instances are traversed. Other
 * values (primitives, class instances, etc.) are left as-is.
 *
 * @example
 * ```ts
 * import { deepFreezeObject } from '@sorowill/sdk';
 *
 * const will = deepFreezeObject(await client.getWill('1'));
 * will.balance = '999999'; // TypeScript error at runtime: cannot assign to read-only property
 * ```
 */
export function deepFreezeObject<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  // Freeze plain objects and arrays recursively.
  if (typeof value === 'object') {
    Object.freeze(value);

    for (const key of Object.keys(value)) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
        deepFreezeObject(child);
      }
    }
  }

  return value;
}
