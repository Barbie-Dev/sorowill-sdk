/** Base class for errors raised by the SoroWill SDK. */
export class SoroWillError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Raised when an amount string passed to {@link SoroWillClient.createWill} or
 * {@link SoroWillClient.topUp} is not a valid positive integer. This catches
 * zero, negative, and malformed (non-numeric) strings before they reach
 * `BigInt()` or the contract's own validation round-trip.
 */
export class SoroWillInvalidAmountError extends SoroWillError {
  readonly amount: string;

  constructor(amount: string, options?: ErrorOptions) {
    super(
      `Invalid amount "${amount}": must be a string representing a positive integer (e.g. "1000000").`,
      options,
    );
    this.amount = amount;
  }
}

/** Raised when an RPC call exceeds its configured deadline. */
export class RequestTimeoutError extends SoroWillError {
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(`SoroWill RPC request timed out after ${timeoutMs}ms`, options);
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when Freighter's `isConnected()` API reports an error other than
 * the extension simply being absent — e.g. it was called outside a browser,
 * or Freighter itself hit an internal error. Distinguishing this from "not
 * installed" avoids prompting an install when Freighter is actually present
 * but in an unexpected state.
 */
export class FreighterInstallCheckError extends SoroWillError {
  readonly code: number;

  constructor(code: number, message: string, options?: ErrorOptions) {
    super(`Unable to determine whether Freighter is installed: ${message}`, options);
    this.code = code;
  }
}

/**
 * Raised when the `contractId` passed to the {@link SoroWillClient} constructor
 * is not a syntactically valid Stellar contract address (wrong length, wrong
 * StrKey version byte, or not valid base32). Thrown synchronously before any
 * RPC call is made, giving callers a clear SDK-level error rather than a
 * low-level StrKey-decoding message.
 */
export class InvalidContractIdError extends SoroWillError {
  /** The invalid contract ID that was supplied. */
  readonly contractId: string;

  constructor(contractId: string, options?: ErrorOptions) {
    super(
      `"${contractId}" is not a valid SoroWill contract address. ` +
        'A Stellar contract address must be a 56-character StrKey starting with "C".',
      options,
    );
    this.contractId = contractId;
  }
}

/**
 * Raised when the `guardians` list passed to {@link SoroWillClient.createWill}
 * exceeds the contract's `MAX_GUARDIANS` limit. Thrown synchronously before
 * any transaction is built or signed, saving a full round-trip.
 */
export class TooManyGuardiansError extends SoroWillError {
  /** Number of guardians supplied. */
  readonly supplied: number;
  /** Maximum guardians allowed (mirrors the contract's MAX_GUARDIANS). */
  readonly max: number;

  constructor(supplied: number, max: number, options?: ErrorOptions) {
    super(
      `Too many guardians: ${supplied} supplied but the contract allows at most ${max}.`,
      options,
    );
    this.supplied = supplied;
    this.max = max;
  }
}

/**
 * Raised when a secret key passed to {@link signWithSecretKey} or
 * {@link signFeeBumpXdr} is not a syntactically valid Stellar secret key.
 * Checks include wrong length, wrong StrKey version byte, or invalid base32 encoding.
 * Thrown synchronously before signing begins, giving callers a clear SDK-level
 * error rather than a low-level StrKey-decoding message.
 */
export class InvalidSecretKeyError extends SoroWillError {
  constructor(functionName: string, options?: ErrorOptions) {
    super(
      `The secret key passed to ${functionName}() is not a valid Stellar secret key. ` +
        'A Stellar secret key must be a 56-character StrKey starting with "S" and containing valid base32 characters.',
      options,
    );
  }
}

/**
 * Raised when a public key passed to an SDK function (for example the
 * `feeSourcePublicKey` of {@link buildFeeBumpXdr}) is not a valid Stellar
 * account public key, so callers get a typed error naming the offending field
 * rather than a low-level StrKey-decoding message.
 */
export class InvalidPublicKeyError extends SoroWillError {
  constructor(
    public readonly field: string,
    options?: ErrorOptions,
  ) {
    super(
      `${field} is not a valid Stellar public key. ` +
        'A Stellar public key must be a 56-character StrKey starting with "G" and containing valid base32 characters.',
      options,
    );
  }
}

/**
 * Raised when {@link SoroWillClient.batch} is given more than one operation.
 * Soroban transactions may contain only a single `InvokeHostFunction`
 * operation, so a multi-operation batch would always be rejected by the
 * network at submission time.
 */
export class UnsupportedBatchSizeError extends SoroWillError {
  constructor(
    public readonly operationCount: number,
    options?: ErrorOptions,
  ) {
    super(
      `A batch may contain only one operation, but ${operationCount} were provided. ` +
        'Soroban transactions allow a single contract invocation (InvokeHostFunction operation) each; ' +
        'submit each call as its own transaction instead.',
      options,
    );
  }
}

/**
 * Raised when the transaction XDR passed to {@link MultisigCollector} constructor
 * or {@link MultisigCollector.fromJSON} is not a syntactically valid Stellar
 * transaction envelope XDR. This includes malformed base64 or unsupported
 * envelope types.
 *
 * Validation happens synchronously at construction time, before the collector
 * is distributed to signers, saving a full multi-party signing round-trip.
 */
export class InvalidTransactionXdrError extends SoroWillError {
  constructor(options?: ErrorOptions) {
    super(
      'The transaction XDR is not a valid Stellar transaction envelope. ' +
        'Ensure the XDR is base64-encoded and represents a valid TransactionEnvelope (v1 or fee-bump).',
      options,
    );
  }
}

/**
 * Raised when the wallet's `signTransaction` call does not resolve within the
 * configured timeout. This can happen when the Freighter popup is dismissed in
 * a way that leaves the underlying promise pending, or when the extension hangs.
 */
export class SignTransactionTimeoutError extends SoroWillError {
  /** The timeout value (in milliseconds) that was exceeded. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: ErrorOptions) {
    super(
      `Wallet signTransaction timed out after ${timeoutMs}ms. ` +
        'The signing popup may have been dismissed or the extension may have hung.',
      options,
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Raised when a beneficiary list fails client-side validation before a
 * transaction is built or sent. Thrown by {@link SoroWillClient.createWill}
 * and {@link SoroWillClient.updateBeneficiaries} when
 * {@link validateBeneficiaries} returns `false`.
 *
 * Possible reasons include: empty list, more than 10 entries, a non-positive
 * or non-integer percentage, or percentages that do not sum to 100.
 */
export class BeneficiaryValidationError extends SoroWillError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Raised by `createWill` before any RPC call when the guardian list is
 * invalid: a malformed Stellar address, a duplicate entry, or the owner's own
 * address. `reason` names the problem and `guardian` the offending address.
 */
export class GuardianValidationError extends SoroWillError {
  readonly reason: 'invalid_address' | 'duplicate' | 'owner_is_guardian';
  readonly guardian: string;

  constructor(
    reason: 'invalid_address' | 'duplicate' | 'owner_is_guardian',
    guardian: string,
    options?: ErrorOptions,
  ) {
    const detail =
      reason === 'invalid_address'
        ? 'is not a valid Stellar public key'
        : reason === 'duplicate'
          ? 'appears more than once'
          : 'is the will owner and cannot also be a guardian';
    super(`Invalid guardian "${guardian}": address ${detail}.`, options);
    this.name = new.target.name;
    this.reason = reason;
    this.guardian = guardian;
  }
}

/**
 * Raised when the connected wallet's active network does not match the
 * network {@link SoroWillClient} was configured with — e.g. Freighter is set
 * to mainnet while the app instantiated a testnet client. Thrown before a
 * transaction is built and sent for signing.
 */
export class WalletNetworkMismatchError extends SoroWillError {
  readonly expectedNetworkPassphrase: string;
  readonly actualNetworkPassphrase: string;

  constructor(expectedNetworkPassphrase: string, actualNetworkPassphrase: string, options?: ErrorOptions) {
    super(
      `The connected wallet is on network "${actualNetworkPassphrase}", but this client is configured for "${expectedNetworkPassphrase}". Switch the wallet's network or reconfigure the client before signing.`,
      options,
    );
    this.expectedNetworkPassphrase = expectedNetworkPassphrase;
    this.actualNetworkPassphrase = actualNetworkPassphrase;
  }
}

/** Base class for typed errors returned by the SoroWill contract. */
export class WillContractError extends SoroWillError {
  constructor(
    readonly code: number,
    readonly contractError: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

type ContractErrorConstructor = new (options?: ErrorOptions) => WillContractError;

function defineContractError(
  code: number,
  contractError: string,
  message: string,
): ContractErrorConstructor {
  return class extends WillContractError {
    constructor(options?: ErrorOptions) {
      super(code, contractError, message, options);
      this.name = `${contractError}Error`;
    }
  };
}

export const WillNotFoundError = defineContractError(1, 'WillNotFound', 'The will was not found');
export const NotOwnerError = defineContractError(2, 'NotOwner', 'The caller is not the will owner');
export const WillNotActiveError = defineContractError(
  3,
  'WillNotActive',
  'The will is not active',
);
export const WillNotTriggeredError = defineContractError(
  4,
  'WillNotTriggered',
  'The will has not been triggered',
);
export const GracePeriodNotExpiredError = defineContractError(
  5,
  'GracePeriodNotExpired',
  'The grace period has not expired',
);
export const GracePeriodExpiredError = defineContractError(
  6,
  'GracePeriodExpired',
  'The grace period has expired',
);
export const InvalidPercentagesError = defineContractError(
  7,
  'InvalidPercentages',
  'Beneficiary percentages must sum to 100',
);
export const AlreadyVotedError = defineContractError(
  8,
  'AlreadyVoted',
  'The guardian has already voted',
);
export const NotGuardianError = defineContractError(
  9,
  'NotGuardian',
  'The caller is not a guardian',
);
export const CheckinNotDueError = defineContractError(
  10,
  'CheckinNotDue',
  'The check-in deadline has not passed',
);
export const ZeroAmountError = defineContractError(
  11,
  'ZeroAmount',
  'The amount must be greater than zero',
);
export const TooManyBeneficiariesError = defineContractError(
  12,
  'TooManyBeneficiaries',
  'Too many beneficiaries or guardians were supplied',
);
export const WillNotSettledError = defineContractError(
  13,
  'WillNotSettled',
  'The will must be released or cancelled for this action',
);
export const WillNotBothActiveError = defineContractError(
  14,
  'WillNotBothActive',
  'Both wills must be active to merge them',
);
export const SameWillIdError = defineContractError(
  15,
  'SameWillId',
  'The same will id was provided for both sides of the merge',
);
export const MergeWouldExceedLimitsError = defineContractError(
  16,
  'MergeWouldExceedLimits',
  'Merging would exceed the beneficiary or guardian limits',
);
export const OwnerCannotBeGuardianError = defineContractError(
  17,
  'OwnerCannotBeGuardian',
  'The owner cannot be a guardian of their own will',
);
export const BeneficiaryNotFoundError = defineContractError(
  18,
  'BeneficiaryNotFound',
  'The beneficiary was not found in the will',
);
export const KeeperBountyExceedsMaxError = defineContractError(
  19,
  'KeeperBountyExceedsMax',
  'The keeper bounty exceeds the maximum allowed (100 bps / 1%)',
);
export const InvalidGuardianThresholdError = defineContractError(
  20,
  'InvalidGuardianThreshold',
  'The guardian threshold must be between 1 and the number of guardians',
);
export const FixedAmountExceedsBalanceError = defineContractError(
  21,
  'FixedAmountExceedsBalance',
  "The fixed-amount allocations exceed the will's balance",
);
export const InvalidPercentageError = defineContractError(
  22,
  'InvalidPercentage',
  'A beneficiary percentage is outside the valid range',
);
export const WillNotReleasedError = defineContractError(
  23,
  'WillNotReleased',
  'The will must be released for this action',
);
export const NotSameOwnerError = defineContractError(
  24,
  'NotSameOwner',
  'Both wills must be owned by the same address to merge them',
);
export const InvalidPeriodError = defineContractError(
  25,
  'InvalidPeriod',
  'The check-in or grace period is zero or too large',
);
export const DuplicateGuardianError = defineContractError(
  26,
  'DuplicateGuardian',
  'The same guardian address was supplied more than once',
);
export const GuardianCooldownActiveError = defineContractError(
  27,
  'GuardianCooldownActive',
  'The guardian-list cooldown has not yet elapsed',
);
export const InvalidTokenError = defineContractError(
  28,
  'InvalidToken',
  'The supplied token is not a valid SEP-41 token',
);
export const DuplicateBeneficiaryError = defineContractError(
  29,
  'DuplicateBeneficiary',
  'The same beneficiary address was supplied more than once',
);
export const WillNotConfirmedError = defineContractError(
  30,
  'WillNotConfirmed',
  'The will is not awaiting confirmation',
);
export const ConfirmationWindowExpiredError = defineContractError(
  31,
  'ConfirmationWindowExpired',
  'The confirmation window has expired',
);
export const TooManyIdsError = defineContractError(
  32,
  'TooManyIds',
  'Too many will ids were supplied',
);
export const InsufficientBalanceError = defineContractError(
  33,
  'InsufficientBalance',
  "The requested split exceeds the will's current balance",
);
export const InvalidSplitError = defineContractError(
  34,
  'InvalidSplit',
  'The split beneficiary list is empty or otherwise invalid',
);
export const InvalidPreimageError = defineContractError(
  35,
  'InvalidPreimage',
  'The revealed pre-image does not match any stored commitment',
);
export const AlreadyClaimedError = defineContractError(
  36,
  'AlreadyClaimed',
  'This hashed beneficiary slot has already been claimed',
);
export const TooManyWillsError = defineContractError(
  37,
  'TooManyWills',
  'An owner or beneficiary index is already at its will-count limit',
);

const CONTRACT_ERRORS: Readonly<Record<number, ContractErrorConstructor>> = {
  1: WillNotFoundError,
  2: NotOwnerError,
  3: WillNotActiveError,
  4: WillNotTriggeredError,
  5: GracePeriodNotExpiredError,
  6: GracePeriodExpiredError,
  7: InvalidPercentagesError,
  8: AlreadyVotedError,
  9: NotGuardianError,
  10: CheckinNotDueError,
  11: ZeroAmountError,
  12: TooManyBeneficiariesError,
  13: WillNotSettledError,
  14: WillNotBothActiveError,
  15: SameWillIdError,
  16: MergeWouldExceedLimitsError,
  17: OwnerCannotBeGuardianError,
  18: BeneficiaryNotFoundError,
  19: KeeperBountyExceedsMaxError,
  20: InvalidGuardianThresholdError,
  21: FixedAmountExceedsBalanceError,
  22: InvalidPercentageError,
  23: WillNotReleasedError,
  24: NotSameOwnerError,
  25: InvalidPeriodError,
  26: DuplicateGuardianError,
  27: GuardianCooldownActiveError,
  28: InvalidTokenError,
  29: DuplicateBeneficiaryError,
  30: WillNotConfirmedError,
  31: ConfirmationWindowExpiredError,
  32: TooManyIdsError,
  33: InsufficientBalanceError,
  34: InvalidSplitError,
  35: InvalidPreimageError,
  36: AlreadyClaimedError,
  37: TooManyWillsError,
};

function errorText(
  error: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): string {
  if (depth >= 5) {
    return '[error depth limit reached]';
  }
  if (error instanceof Error) {
    if (seen.has(error)) {
      return error.message;
    }
    seen.add(error);
    return `${error.message} ${error.cause === undefined ? '' : errorText(error.cause, seen, depth + 1)}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object') {
    if (seen.has(error)) {
      return '[circular error object]';
    }
    seen.add(error);
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Raised when a Soroban simulation returns an error result.
 *
 * The raw simulation error string (which may contain contract addresses or
 * other request details) is kept as a structured property — not embedded in
 * the message — so callers can decide whether to log or redact it before
 * forwarding to an error-tracking service.
 */
export class SimulationError extends SoroWillError {
  /**
   * The raw error string returned by the Soroban RPC simulation. May contain
   * contract addresses or other context. Do not forward this to third-party
   * error trackers without redaction.
   */
  readonly simulationError: string;

  constructor(method: string, simulationError: string, options?: ErrorOptions) {
    super(`SoroWill simulation failed for ${method}`, options);
    this.simulationError = simulationError;
  }
}

/**
 * Raised when a Soroban transaction submission returns an ERROR status.
 *
 * The raw XDR error result blob is kept as a structured property — not
 * embedded in the message — so callers can decide whether to log or redact it
 * before forwarding to an error-tracking service.
 */
export class TransactionSubmissionError extends SoroWillError {
  /**
   * The base64-encoded XDR error result returned by the Soroban RPC node.
   * Contains encoded transaction details. Do not forward this to third-party
   * error trackers without redaction.
   */
  readonly errorXdr: string;

  constructor(label: string, errorXdr: string, options?: ErrorOptions) {
    super(`SoroWill transaction submission failed for ${label}`, options);
    this.errorXdr = errorXdr;
  }
}

/**
 * Raised when the account returned by `getAccount()` is not found or has
 * never been funded on the current network. A common situation for brand-new
 * testnet addresses or mainnet addresses that have not yet received the
 * minimum XLM reserve.
 *
 * The `publicKey` is stored as a structured property rather than being
 * embedded in the message so callers can decide how to handle it (e.g.
 * redacting or hashing it before forwarding to an error-tracking service).
 */
export class AccountNotFundedError extends SoroWillError {
  /** The Stellar public key whose account could not be loaded. */
  readonly publicKey: string;

  constructor(publicKey: string, options?: ErrorOptions) {
    super(
      `The Stellar account for the connected wallet has not been funded on this network. ` +
        `Fund the account with the minimum XLM reserve before submitting transactions.`,
      options,
    );
    this.publicKey = publicKey;
  }
}

/**
 * Raised when a state-changing contract invocation fails — either because
 * `sendTransaction` returned `ERROR`, or because the polled transaction did
 * not reach `SUCCESS`. Unlike the previous bare `Error` throws, this class
 * preserves the underlying RPC diagnostic payload so callers (and debugging
 * tools) can inspect the root cause.
 */
export class InvokeFailedError extends SoroWillError {
  /**
   * Diagnostic data from the RPC response. May include fields such as
   * `errorXdr`, `diagnosticEventsXdr`, `resultXdr`, or `status` depending
   * on which failure branch was hit. Treat as untrusted/sensitive before
   * forwarding to third-party error-tracking services.
   */
  readonly diagnostics: Record<string, unknown>;

  constructor(method: string, reason: string, diagnostics: Record<string, unknown>, options?: ErrorOptions) {
    super(`SoroWill transaction for ${method} failed: ${reason}`, options);
    this.diagnostics = diagnostics;
  }
}

/**
 * Raised when a pagination cursor supplied by the caller fails validation.
 *
 * The offending cursor string is kept as a structured property — not embedded
 * in the message — because it is user-supplied data that could contain
 * arbitrary content, and embedding it in the message would surface it in any
 * error-tracking pipeline.
 */
export class InvalidCursorError extends SoroWillError {
  /**
   * The cursor value that failed validation. User-supplied; treat as
   * untrusted before logging.
   */
  readonly cursor: string;

  constructor(cursor: string, options?: ErrorOptions) {
    super('Invalid pagination cursor', options);
    this.cursor = cursor;
  }
}

export class InvalidPaginationOptionsError extends SoroWillError {
  readonly option: string;
  readonly value: number | undefined;

  constructor(option: string, value: number | undefined, options?: ErrorOptions) {
    super(`${option} must be a positive integer`, options);
    this.option = option;
    this.value = value;
  }
}

export class InvalidDayCountError extends SoroWillError {
  readonly paramName: string;
  readonly value: number;

  constructor(paramName: string, value: number, options?: ErrorOptions) {
    super(
      `"${paramName}" must be a positive integer (received ${value}). ` +
        `Fractional or non-positive day counts are not supported.`,
      options,
    );
    this.paramName = paramName;
    this.value = value;
  }
}

/**
 * Raised when a Soroban simulation returns a "restore required" result,
 * indicating that archived/expired ledger entries must be restored via a
 * separate {@link https://developers.stellar.org/docs/smart-contracts/guides/archival | footprint-restoration transaction}
 * before the call can proceed.
 *
 * The caller should build and submit a `restoreFootprint` operation using
 * the {@link restorePreamble} from this error, wait for confirmation, and
 * then retry the original contract call.
 */
export class SoroWillRestoreRequiredError extends SoroWillError {
  /** The simulation response containing the restore preamble needed to build
   * the footprint-restoration transaction. */
  readonly simulation: unknown;

  constructor(message: string, simulation: unknown, options?: ErrorOptions) {
    super(message, options);
    this.simulation = simulation;
  }
}

/**
 * Raised when {@link SoroWillClient.subscribeToEvents} is called with
 * `{ transport: 'websocket' }` but the client was not constructed with both
 * `webSocketFactory` and `eventStreamUrl`. Thrown instead of silently
 * downgrading to polling, since an explicit `'websocket'` request implies the
 * caller relies on WebSocket-specific behavior (e.g. push latency).
 */
export class WebSocketNotConfiguredError extends SoroWillError {
  constructor(options?: ErrorOptions) {
    super(
      'transport: "websocket" was requested but this client was not configured with ' +
        'both webSocketFactory and eventStreamUrl. Configure both, or use transport: "auto" ' +
        'to allow falling back to polling.',
      options,
    );
  }
}

/** Converts a Soroban contract error code embedded in an RPC error into its typed SDK error. */
export function mapContractError(error: unknown): Error {
  if (error instanceof WillContractError || error instanceof RequestTimeoutError) {
    return error;
  }
  const text = errorText(error);
  const match =
    /Error\(Contract,\s*#?(\d+)\)/i.exec(text) ??
    /(?:contract error|contracterror|error code)[^\d#]*#?(\d+)/i.exec(text);
  const codeText = match?.[1];
  const ErrorClass = codeText === undefined ? undefined : CONTRACT_ERRORS[Number(codeText)];
  return ErrorClass === undefined ? (error instanceof Error ? error : new SoroWillError(text)) : new ErrorClass({ cause: error });
}
