/**
 * Numeric error codes returned by the SoroWill contract, mirroring the
 * `WillError` enum in the contract's `errors.rs`.
 *
 * **IMPORTANT**: These values must be kept in sync manually with the
 * contract repo until the spec-drift tooling proposed there exists.
 *
 * @see {@link https://github.com/SoroWill/sorowill-contracts/blob/main/contracts/will/src/errors.rs}
 */
export enum WillErrorCode {
  /** The will was not found. */
  WillNotFound = 1,
  /** The caller is not the will owner. */
  NotOwner = 2,
  /** The will is not in the Active state. */
  WillNotActive = 3,
  /** The will has not been triggered. */
  WillNotTriggered = 4,
  /** The grace period has not expired yet. */
  GracePeriodNotExpired = 5,
  /** The grace period has already expired. */
  GracePeriodExpired = 6,
  /** Beneficiary percentages do not sum to 100. */
  InvalidPercentages = 7,
  /** The guardian has already voted in this cycle. */
  AlreadyVoted = 8,
  /** The caller is not a guardian of the will. */
  NotGuardian = 9,
  /** The check-in deadline has not yet passed. */
  CheckinNotDue = 10,
  /** The supplied amount is zero. */
  ZeroAmount = 11,
  /** Too many beneficiaries (exceeds {@link MAX_BENEFICIARIES}). */
  TooManyBeneficiaries = 12,
  /** The action requires the will to be `Released` or `Cancelled`. */
  WillNotSettled = 13,
  /** A merge was attempted but one or both wills are not `Active`. */
  WillNotBothActive = 14,
  /** A merge was attempted with the same will id for both sides. */
  SameWillId = 15,
  /** A merge would exceed the beneficiary or guardian limits. */
  MergeWouldExceedLimits = 16,
  /** The owner cannot also be a guardian of their own will. */
  OwnerCannotBeGuardian = 17,
  /** The referenced beneficiary is not in the will's beneficiary list. */
  BeneficiaryNotFound = 18,
  /** The keeper bounty exceeds the maximum allowed (100 bps / 1%). */
  KeeperBountyExceedsMax = 19,
  /** The guardian threshold is out of range (must be 1..=guardians.len()). */
  InvalidGuardianThreshold = 20,
  /** The sum of all fixed-amount allocations exceeds the will's balance. */
  FixedAmountExceedsBalance = 21,
  /** A single beneficiary percentage is outside the valid range. */
  InvalidPercentage = 22,
  /** The action requires the will to be `Released`. */
  WillNotReleased = 23,
  /** A merge was attempted between wills owned by different addresses. */
  NotSameOwner = 24,
  /** A check-in or grace period was zero or too large to represent. */
  InvalidPeriod = 25,
  /** The same address was supplied more than once in a guardian list. */
  DuplicateGuardian = 26,
  /** The guardian-list cooldown has not yet elapsed. */
  GuardianCooldownActive = 27,
  /** The supplied token does not respond to a `decimals()` probe (not SEP-41). */
  InvalidToken = 28,
  /** The same beneficiary address was supplied more than once. */
  DuplicateBeneficiary = 29,
  /** `confirm_will` was called on a will that is not `PendingConfirmation`. */
  WillNotConfirmed = 30,
  /** `confirm_will` was called after the confirmation deadline elapsed. */
  ConfirmationWindowExpired = 31,
  /** `get_wills` was called with more ids than the contract allows. */
  TooManyIds = 32,
  /** `split_will` was asked to split more than the will's current balance. */
  InsufficientBalance = 33,
  /** `split_will` was called with an empty or otherwise invalid split. */
  InvalidSplit = 34,
  /** `reveal_and_claim` was called with a pre-image matching no commitment. */
  InvalidPreimage = 35,
  /** `reveal_and_claim` was called for a slot that was already claimed. */
  AlreadyClaimed = 36,
  /** An owner or beneficiary index is full and cannot accept another will id. */
  TooManyWills = 37,
}

/**
 * A single beneficiary entry: an address and the percentage of the will's
 * balance it is entitled to receive when the inheritance is released.
 *
 * `percentage` is on a 0-100 scale (a positive number — integers and
 * reasonable fractional values like `33.33` are both accepted), and a will's
 * beneficiary percentages must sum to 100. The SDK converts this to
 * the contract's internal basis-point representation (0-10,000, summing to
 * 10,000) when submitting a transaction, so a `percentage` of `30` is bound
 * on-chain as `3000` basis points.
 *
 * ## Change history
 * | SDK version | Change |
 * |-------------|--------|
 * | 0.1.0       | Interface introduced with `address` and `percentage` fields. |
 * | 0.1.1       | `percentage` scale clarified as 0-100 (not basis points); on-chain representation changed from raw `percentage` to `basis_points` (×100). Existing consumers storing percentages as basis points must divide by 100. |
 *
 * @since 0.1.0
 */
/**
 * A single beneficiary of a will, with their Stellar address and percentage
 * share of the will's balance.
 *
 * ## Validation constraints
 * - `address` must be a valid Stellar public key (StrKey encoded, `G` prefix).
 *   Use {@link StrKey.isValidEd25519PublicKey} from `@stellar/stellar-sdk` to
 *   validate client-side before submission.
 * - `percentage` must be an integer in the range 0–100 (inclusive).
 * - Across all beneficiaries in a single will, percentages must sum to exactly
 *   100.
 *
 * These constraints are enforced client-side by {@link validateBeneficiaries}
 * (called by {@link SoroWillClient.createWill} and
 * {@link SoroWillClient.updateBeneficiaries}) and by the on-chain contract
 * (error codes {@link WillErrorCode.InvalidPercentage} and
 * {@link WillErrorCode.InvalidPercentages}).
 *
 * @example
 * ```ts
 * const beneficiary: Beneficiary = {
 *   address: 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG',
 *   percentage: 60,
 * };
 * ```
 *
 * @since 0.1.0
 */
export interface Beneficiary {
  /**
   * Stellar address of the beneficiary. Must be a valid Ed25519 public key
   * encoded as a StrKey string (e.g. `GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG`).
   *
   * @example 'GA3JE5IXBSOR6DCLZSGN7JIWQWO45RCS7PUFKKVXWSTE4Y75ISIDMHJG'
   * @since 0.1.0
   */
  address: string;
  /**
   * Share of the will's balance this beneficiary receives, expressed as a
   * whole percentage on the 0–100 scale. All beneficiary percentages in a
   * will must sum to exactly 100.
   *
   * **Constraint**: must be an integer between 0 and 100 (inclusive).
   *
   * **Breaking change in 0.1.1:** prior to 0.1.1 this field was named
   * `basisPoints` and stored the raw on-chain value (0–10 000). It was
   * renamed to `percentage` and re-scaled to 0–100 to match the SDK's
   * public semantics. If you stored beneficiary objects from SDK < 0.1.1,
   * divide each saved value by 100 to convert.
   *
   * @example 60
   * @since 0.1.1
   */
  percentage: number;
}

/**
 * Lifecycle state of a will, mirroring `WillStatus` in the SoroWill contract.
 *
 * ## Change history
 * | SDK version | Change |
 * |-------------|--------|
 * | 0.1.0       | Enum introduced with `Active`, `Triggered`, `Released`, `Cancelled`. |
 * | 0.1.1       | `PendingConfirmation` and `Settled` states added to reflect new contract lifecycle stages. Any exhaustive switch/if-chain over `WillStatus` values **must** handle these new variants. |
 *
 * @since 0.1.0
 */
export enum WillStatus {
  /**
   * The will has been created but is not yet fully confirmed on-chain
   * (e.g. awaiting initial deposit settlement).
   * @since 0.1.1
   */
  PendingConfirmation = 'PendingConfirmation',
  /**
   * The will is funded and the owner is checking in on schedule.
   * @since 0.1.0
   */
  Active = 'Active',
  /**
   * The owner missed a check-in deadline; the grace period is running.
   * @since 0.1.0
   */
  Triggered = 'Triggered',
  /**
   * The grace period expired (or guardians reached quorum) and funds were released.
   * @since 0.1.0
   */
  Released = 'Released',
  /**
   * The owner cancelled the will and withdrew the remaining balance.
   * @since 0.1.0
   */
  Cancelled = 'Cancelled',
  /**
   * The will has been fully settled: all balances distributed and the record is closed.
   * @since 0.1.1
   */
  Settled = 'Settled',
}

/**
 * The full on-chain state of a single will, decoded into native JS types.
 *
 * ## Change history
 * | SDK version | Change |
 * |-------------|--------|
 * | 0.1.0       | Interface introduced. Fields: `id`, `owner`, `token`, `balance`, `beneficiaries`, `checkinPeriodDays`, `gracePeriodDays`, `lastCheckin`, `triggerTime`, `status`, `guardians`, `guardianVotes`. |
 * | 0.1.1       | `beneficiaries[].percentage` changed from raw basis points (0–10 000) to a 0–100 percentage scale. **Breaking**: stored beneficiary values from SDK ≤ 0.1.0 must be divided by 100. `status` gains two new variants: `PendingConfirmation` and `Settled` — exhaustive switch statements must handle them. |
 *
 * @see {@link Beneficiary} for the beneficiary scale change details.
 * @see {@link WillStatus} for the new status variants.
 * @since 0.1.0
 */
export interface Will {
  /**
   * Unique identifier for this will, as a decimal string (contract-side `u64`).
   * @since 0.1.0
   */
  id: string;
  /**
   * The address that created and funds the will.
   * @since 0.1.0
   */
  owner: string;
  /**
   * The token contract address (e.g. a USDC Stellar Asset Contract) held by the will.
   * @since 0.1.0
   */
  token: string;
  /**
   * The amount of `token` currently locked, in base units, as a decimal string.
   * @since 0.1.0
   */
  balance: string;
  /**
   * The beneficiaries and their percentage shares (0-100 scale). Always sums
   * to 100. On-chain these are stored as basis points summing to 10,000; the
   * SDK exposes them on the 0-100 `percentage` scale.
   *
   * **Breaking change in 0.1.1:** prior to 0.1.1 each entry's `percentage`
   * was stored as raw basis points (0–10 000). Divide stored values by 100 to
   * migrate.
   * @since 0.1.0
   */
  beneficiaries: Beneficiary[];
  /**
   * How many days the owner may go without checking in before the will can be triggered.
   * @since 0.1.0
   */
  checkinPeriodDays: number;
  /**
   * How many days after being triggered the owner has to prove they are alive.
   * @since 0.1.0
   */
  gracePeriodDays: number;
  /**
   * When the owner last checked in.
   * @since 0.1.0
   */
  lastCheckin: Date;
  /**
   * When the will was triggered, or `null` if it has never been triggered.
   * @since 0.1.0
   */
  triggerTime: Date | null;
  /**
   * Current lifecycle state of the will.
   *
   * **Breaking change in 0.1.1:** two new variants were added —
   * `PendingConfirmation` and `Settled`. If your code uses an exhaustive
   * switch/if-chain over `WillStatus`, add handling for these new values.
   * @since 0.1.0
   */
  status: WillStatus;
  /**
   * Optional guardian addresses (up to 3) who may force an early release.
   * @since 0.1.0
   */
  guardians: string[];
  /**
   * Number of distinct guardians who have voted in the current release cycle.
   * @since 0.1.0
   */
  guardianVotes: number;
}

/** Parameters for {@link SoroWillClient.createWill}. */
export interface CreateWillParams {
  /** The token contract address (e.g. a USDC Stellar Asset Contract) to lock. */
  token: string;
  /** The amount of `token` to lock, in base units, as a decimal string. */
  amount: string;
  /**
   * 1 to 10 beneficiaries whose `percentage` values (0-100 scale) sum to
   * exactly 100. The SDK scales these to basis points (summing to 10,000)
   * before submitting to the contract.
   */
  beneficiaries: Beneficiary[];
  /** How many days the owner may go without checking in. */
  checkinPeriodDays: number;
  /** How many days after being triggered the owner has to prove they are alive. */
  gracePeriodDays: number;
  /** 0 to 3 guardian addresses that may jointly force an early release. */
  guardians: string[];
}

/** Parameters for {@link SoroWillClient.updateBeneficiaries}. */
export interface UpdateBeneficiariesParams {
  willId: string;
  beneficiaries: Beneficiary[];
}

/** Optional client-side pagination controls for list-style SDK methods. */
export interface PaginationOptions {
  /** Maximum number of wills to return in this page. */
  pageSize?: number;
  /** Opaque cursor returned by the previous page, if any. */
  cursor?: string | undefined;
}

/** A page of wills plus the cursor needed to fetch the next page, if any. */
export interface PaginatedWillsResult {
  wills: Will[];
  nextCursor: string | null;
}


/**
 * A function that signs a transaction envelope (XDR) and resolves to the
 * signed XDR.
 *
 * Adapters may resolve either with the signed XDR string directly or with a
 * {@link SignatureResponse} object. The SDK normalizes both shapes to a string
 * via {@link normalizeSignatureResponse} and rejects anything else with a
 * clear error, so a malformed adapter response fails at signing time rather
 * than silently downstream.
 */
export type TransactionSigner<T = void> = (
  xdr: string,
) => Promise<string | T>;

/** Normalized contract event emitted by the SoroWill contr

/* … truncated 2578 chars — edit only what you need near the top … */

/**
 * A single contract invocation to be executed as part of a batch.
 *
 * ### Networks (#550)
 *
 * `network` is optional. When present it declares which Stellar network the
 * operation is intended for (`'testnet'` or `'mainnet'`). Every operation in
 * a batch must agree on the same network, and that network must match the
 * client's configured network:
 *
 * - Operations that omit `network` inherit the client's network and are
 *   therefore always compatible with it.
 * - If any operation specifies a network that differs from the client's
 *   network, or if two operations specify *different* networks, the batch is
 *   rejected with a {@link BatchNetworkMismatchError} before any transaction
 *   is built, signed, or submitted.
 *
 * This prevents a batch from silently mixing testnet and mainnet operations,
 * which would otherwise fail (or, worse, succeed against the wrong network)
 * deep inside the signing flow.
 */
export interface BatchOperation {
  /** The contract method to invoke (e.g. `'create_will'`). */
  method: string;
  /** The arguments to the method as a record of name-value pairs. */
  args: Record<string, unknown>;
  /**
   * The Stellar network this operation targets. Omit to inherit the client's
   * configured network.
   */
  network?: 'testnet' | 'mainnet';
}

export interface BatchResult {
  success: boolean;
  error?: Error;
}

export interface RequestOptions {
  signal?: AbortSignal;
  retries?: number;
  timeout?: number;
  timeoutMs?: number;
  /**
   * When `true`, skips the client-side will-existence pre-check (e.g.
   * `getWill()`) before submitting a state-changing transaction. Use only when
   * the caller has already confirmed the will exists, to avoid an extra RPC
   * round-trip. Methods that require the will's on-chain state for their
   * return value (e.g. `checkIn`'s `nextDeadline`) may return a best-effort
   * value when this is set.
   * @default false
   */
  skipExistenceCheck?: boolean;
}

/** Options for emergency check-in, optionally providing guardian signatures. */
export interface EmergencyCheckInOptions extends RequestOptions {
  /** Optional guardian signature approving the emergency check-in. */
  guardianSignature?: string;
  /** Optional list of guardian signatures approving the emergency check-in. */
  guardianSignatures?: string[];
}

export interface SoroWillEvent {
  id: string;
  type: string;
  cursor: string;
  ledger: number | null;
  ledgerClosedAt: Date | null;
  contractId: string;
  txHash: string | null;
  topics: unknown[];
  value: unknown;
  raw: unknown;
}

/**
 * A handle to an active event subscription.
 *
 * ### Handler semantics (#548)
 *
 * A subscription has **exactly one** handler: the `listener` passed to
 * `subscribeToEvents()`. The type does not allow adding further handlers
 * after the fact — there is no `addHandler()`/`on()` method.
 *
 * - **Exclusivity**: one subscription delivers each event to one listener
 *   only. Events are never fanned out to multiple handlers of the same
 *   subscription. If you need several consumers, call
 *   `subscribeToEvents()` once per consumer and give each subscription its own
 *   listener; each subscription then receives its own copy of the stream.
 * - **Ordering**: events are delivered to the listener in the order the
 *   network produced them — ascending ledger sequence, and within a ledger,
 *   ascending event order. Delivery is strictly sequential: the next event is
 *   not dispatched until the listener for the previous one has returned.
 * - **Error isolation**: if the listener throws, the failure is contained to
 *   that single event. The subscription stays open, the remaining events in
 *   the same batch are still delivered, and the error is reported through
 *   `EventSubscriptionOptions.onError`. This holds for both the WebSocket and
 *   the polling transport.
 */
export interface EventSubscription {
  /** Stops the subscription. Safe to call more than once. */
  unsubscribe(): void;
  /** Alias for {@link EventSubscription.unsubscribe}. */
  close(): void;
  /** The transport actually in use, once the subscription has been established. */
  transport?: EventSubscriptionTransport;
  /** Whether the subscription has been closed. */
  closed?: boolean;
}

export interface EventSubscriptionOptions {
  transport?: EventSubscriptionTransport;
  retryAttempts?: number;
  retryDelayMs?: number;
  websocketConnectTimeoutMs?: number;
  pollIntervalMs?: number;
  pageSize?: number;
  cursor?: string;
  onError?: (error: Error) => void;
}

export type EventSubscriptionTransport = 'websocket' | 'polling';
