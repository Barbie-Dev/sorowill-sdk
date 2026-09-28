import {
  Account,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  Transaction,
  TransactionBuilder,
  rpc,
  xdr,
  contract as stellarContract,
} from '@stellar/stellar-sdk';

import {
  createReadCacheKey,
  ReadCache,
  type ReadCacheOptions,
} from './cache';
import {
  unsubscribeFromWillEvents,
  type WillEventSource,
  type WillEventSubscription,
} from './events';
import type {
  BatchOperation,
  BatchResult,
  Beneficiary,
  CreateWillParams,
  EventSubscription,
  EventSubscriptionOptions,
  PaginatedWillsResult,
  PaginationOptions,
  RequestOptions,
  SoroWillEvent,
  UpdateBeneficiariesParams,
  Will,
} from './types';
import { WillStatus } from './types';
import {
  getDefaultWalletAdapter,
  type WalletAdapter,
} from './wallet';
import {
  AccountNotFundedError,
  BeneficiaryValidationError,
  GuardianValidationError,
  InvalidDayCountError,
  InvalidContractIdError,
  InvalidCursorError,
  InvalidPaginationOptionsError,
  InvokeFailedError,
  RequestTimeoutError,
  mapContractError,
  RequestTimeoutError,
  SimulationError,
  SoroWillError,
  SoroWillInvalidAmountError,
  SoroWillRestoreRequiredError,
  TooManyGuardiansError,
  UnsupportedBatchSizeError,
  WalletNetworkMismatchError,
  WebSocketNotConfiguredError,
} from './errors';
import { hasDuplicateBeneficiaries, MAX_GUARDIANS, validateBeneficiaries } from './utils';
import { RequestQueue } from './requestQueue';
import { InFlightTracker } from './inFlightTracker';
import { RpcEndpointPool } from './rpc';
import { buildSep7TxUri, type BuildSep7TxUriOptions } from './sep7';
import { HookManager } from './hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from './hooks';
import { assertPreparedTransactionMatchesIntendedOperation } from './txValidation';
import { DebugLogger } from './debugLogger';

/** @internal Local alias for Soroban's `xdr.ScVal`; not part of the public API. */
type ScVal = xdr.ScVal;

const { Spec } = stellarContract;

/** An impossible account used to simulate read-only calls without a connected wallet. */
const NULL_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/** Supported Stellar networks. */
export type SoroWillNetwork = 'testnet' | 'mainnet';

/**
 * Default contract addresses for each network, sourced from the SoroWill
 * contracts repository's `deployments/` manifests.
 *
 * **IMPORTANT — keep in sync on every redeploy.**
 * These values are baked into this SDK release. If the maintainers redeploy
 * the SoroWill contract (e.g. after an upgrade), this map must be updated and
 * a new SDK version published. Consumers who need to pin to a specific
 * deployment — or who are running their own fork — should pass `contractId`
 * explicitly to the `SoroWillClient` constructor rather than relying on this
 * default.
 *
 * @see https://github.com/SoroWill/sorowill-contracts/tree/main/deployments
 */
export const DEFAULT_CONTRACT_IDS: Record<SoroWillNetwork, string> = {
  testnet: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
  // Mainnet is not yet deployed. This placeholder will be replaced when the
  // mainnet contract is live. Calling forNetwork('mainnet') before that happens
  // will throw an error so misconfiguration is caught early.
  mainnet: '',
};

export interface NetworkConfig {
  rpcUrls: string[];
  networkPassphrase: string;
}

export const NETWORK_CONFIG: Record<SoroWillNetwork, NetworkConfig> = {
  testnet: {
    rpcUrls: ['https://soroban-testnet.stellar.org'],
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrls: ['https://mainnet.sorobanrpc.com'],
    networkPassphrase: Networks.PUBLIC,
  },
};

export interface RpcRetryOptions {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export interface SoroWillRpcServer {
  getContractWasmByContractId(contractId: string): Promise<Buffer | Uint8Array>;
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  getAccount(address: string): Promise<Account>;
  prepareTransaction(transaction: Transaction): Promise<Transaction>;
  sendTransaction(transaction: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  pollTransaction(
    hash: string,
    options: { attempts: number },
  ): Promise<rpc.Api.GetTransactionResponse>;
  getFeeStats?(): Promise<rpc.Api.GetFeeStatsResponse>;
  getHealth?(): Promise<rpc.Api.GetHealthResponse>;
}

/** @internal */
interface ContractSpecLike {
  funcArgsToScVals(method: string, args: Record<string, unknown>): ScVal[];
  funcResToNative(method: string, value: ScVal): unknown;
}

type EnvSource = Record<string, string | undefined>;
type FetchImplementation = typeof fetch;

interface WebSocketLike {
  close(): void;
  send(data: string): void;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: Event | unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onopen: ((event: Event | unknown) => void) | null;
}

/** Options for constructing a read cache scoped to SoroWill reads. */
export interface SoroWillReadCacheOptions {
  ttlMs?: number;
}

export type {
  EventSubscription,
  EventSubscriptionOptions,
  EventSubscriptionTransport,
} from './types';

/** Options for constructing a {@link SoroWillClient}. */
export interface SoroWillClientOptions {
  /** Which Stellar network to connect to. */
  network: SoroWillNetwork;
  /** The deployed SoroWill contract's address. */
  contractId: string;
  /** Optional hook manager for intercepting contract calls. */
  hooks?: HookManager;
  /**
   * The wallet used to read the connected account and sign transactions.
   * Defaults to the Freighter browser extension for backwards compatibility.
   */
  wallet?: WalletAdapter;
  /** Read-cache configuration. Pass `false` to disable caching entirely. */
  readCache?: ReadCacheOptions | false;
  /** Event source used to invalidate cached will reads as external updates arrive. */
  eventSource?: WillEventSource;
  /** Retry settings for transient RPC failures. */
  retry?: Partial<RpcRetryOptions>;
  /** Advanced override for testing or custom transports. */
  rpcServer?: SoroWillRpcServer;
  /**
   * Advanced override for testing or preloaded contract specs.
   *
   * By injecting a pre-built spec you can write snapshot tests that lock in
   * the exact `ScVal` / XDR encoding produced by `funcArgsToScVals` for each
   * state-changing method. This guards against silent encoding regressions
   * introduced by a future `@stellar/stellar-sdk` upgrade — the spec object
   * is what drives argument encoding, so swapping it in tests lets you assert
   * the exact serialised shape without making real RPC calls.
   *
   * @example
   * ```ts
   * import { contract } from '@stellar/stellar-sdk';
   *
   * const spec = new contract.Spec(rawSpecXdrEntries);
   *
   * // In your snapshot test:
   * const scVals = spec.funcArgsToScVals('create_will', { owner: 'G...', ... });
   * expect(scVals.map((v) => v.toXDR('base64'))).toMatchSnapshot();
   *
   * // And in the client under test:
   * const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', spec });
   * ```
   *
   * See `CONTRIBUTING.md` → *ScVal / XDR snapshot tests* for the full
   * workflow, including how to intentionally update snapshots when a
   * dependency upgrade legitimately changes encoding.
   */
  spec?: ContractSpecLike | Promise<ContractSpecLike>;
  /**
   * Advanced override that supplies the deployed contract's raw WASM bytes
   * directly, skipping the lazy `getContractWasmByContractId` RPC round-trip
   * that {@link getSpec} otherwise performs on first use. Takes priority over
   * fetching from the RPC server, but is itself overridden by `spec` if both
   * are provided.
   */
  specJson?: Uint8Array;
  /** Optional override for the Soroban RPC endpoint. */
  rpcUrl?: string;
  /** Optional override for the Stellar network passphrase. */
  networkPassphrase?: string;
  /** Optional override for the endpoint used for event polling. */
  eventRpcUrl?: string;
  /** Optional override for the WebSocket event streaming endpoint. */
  eventStreamUrl?: string;
  /** Default polling interval for event subscriptions. */
  defaultPollIntervalMs?: number;
  /**
   * Optional override for the `fetch` implementation used by event-polling
   * requests inside the SDK.
   *
   * **When to use this:**
   * - Injecting a polyfill in environments where a global `fetch` is not
   *   available (older Node versions, some React Native runtimes).
   * - Adding custom headers or proxy logic to outbound HTTP requests.
   * - Providing a mock in unit tests without patching the global.
   *
   * **Important:** This option only affects the SDK's own HTTP calls (event
   * polling). The underlying `@stellar/stellar-sdk` `rpc.Server` uses its own
   * fetch binding, which cannot be overridden through this option. If you need
   * a custom fetch for all Soroban RPC traffic, install a global fetch
   * polyfill (e.g. `node-fetch` v3, or `cross-fetch`) before constructing the
   * client:
   *
   * ```ts
   * import fetch from 'node-fetch';
   * globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
   * ```
   *
   * @example
   * ```ts
   * import fetch from 'node-fetch';
   *
   * const client = new SoroWillClient({
   *   network: 'testnet',
   *   contractId: 'C...',
   *   fetch: fetch as unknown as typeof globalThis.fetch,
   * });
   * ```
   */
  fetch?: FetchImplementation;
  /** Internal/testing override for WebSocket construction. */
  webSocketFactory?: (url: string) => WebSocketLike;
  /** Default timeout applied to each RPC request. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrentRequests?: number;
  /** Maximum RPC requests started in a rolling one-second window. Defaults to 10. */
  requestsPerSecond?: number;
  /** Optional list of RPC endpoints to use with automatic failover. */
  rpcUrls?: string[];
  /**
   * Maximum number of poll attempts for transaction finality.
   * Defaults to 30. Increase under mainnet congestion.
   */
  pollAttempts?: number;
  /**
   * Enable structured debug logging for operation builds, simulations, and submissions.
   * When enabled, logs operation details without logging secrets or private keys.
   * Defaults to false (opt-in only).
   */
  debug?: boolean;
  /**
   * If a transaction doesn't land within the poll window, automatically
   * rebuild and resubmit with a higher fee instead of throwing.
   * Defaults to false (opt-in).
   */
  autoFeeBumpOnTimeout?: boolean;
  /**
   * The validity window (in seconds) set on every built transaction via
   * `TransactionBuilder.setTimeout()`. Defaults to `30`.
   *
   * Increase this for signing flows that may take longer than 30 seconds
   * (e.g. a hardware wallet whose user needs time to physically approve the
   * transaction on-device), and decrease it if you want transactions to
   * expire more quickly.
   *
   * The value is forwarded to every `read()`, `submit()`, `batch()`, and
   * `buildInvocationTransaction()` call made by this client.
   */
  transactionTimeoutSeconds?: number;
}

/** The raw, snake_case shape of a `Will` as decoded straight off the contract spec. */
interface RawWill {
  id: bigint;
  owner: string;
  token: string;
  balance: bigint;
  beneficiaries: Beneficiary[];
  checkin_period_days: bigint;
  grace_period_days: bigint;
  last_checkin: bigint;
  trigger_time: bigint | undefined;
  status: WillStatus;
  guardians: string[];
  guardian_votes: number;
}

const DEFAULT_POLL_ATTEMPTS = 30;

/**
 * How long `subscribeToEvents` waits for a WebSocket to fire `onopen` before
 * giving up and falling back to HTTP polling. Guards against a server that
 * accepts the TCP/TLS connection but never completes the WebSocket handshake
 * (and never fires `onopen`, `onerror`, or `onclose`), which would otherwise
 * leave the returned promise pending forever.
 */
const DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS = 10_000;

const DEFAULT_RETRY_OPTIONS: RpcRetryOptions = {
  maxAttempts: 1,
  initialDelayMs: 200,
  maxDelayMs: 2_000,
  backoffFactor: 2,
};

/**
 * Guards against a contract spec / SDK version drift silently producing a
 * corrupted `Will`: verifies the value decoded by `funcResToNative` actually
 * has the shape this SDK expects before any of its fields are trusted.
 */
function isRawWillShape(value: unknown): value is RawWill {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === 'bigint' &&
    typeof v.owner === 'string' &&
    typeof v.token === 'string' &&
    typeof v.balance === 'bigint' &&
    Array.isArray(v.beneficiaries) &&
    typeof v.checkin_period_days === 'bigint' &&
    typeof v.grace_period_days === 'bigint' &&
    typeof v.last_checkin === 'bigint' &&
    (v.trigger_time === undefined || typeof v.trigger_time === 'bigint') &&
    typeof v.status === 'string' &&
    Array.isArray(v.guardians) &&
    typeof v.guardian_votes === 'number'
  );
}

function mapWill(raw: unknown): Will {
  if (!isRawWillShape(raw)) {
    throw new SoroWillError(
      'SoroWill received an unexpected shape while decoding a Will from the contract response. ' +
        'This usually means the deployed contract spec and this SDK version have drifted apart.',
    );
  }
  return {
    id: raw.id.toString(),
    owner: raw.owner,
    token: raw.token,
    balance: raw.balance.toString(),
    beneficiaries: fromContractBeneficiaries(raw.beneficiaries),
    checkinPeriodDays: Number(raw.checkin_period_days),
    gracePeriodDays: Number(raw.grace_period_days),
    lastCheckin: new Date(Number(raw.last_checkin) * 1000),
    triggerTime: raw.trigger_time === undefined ? null : new Date(Number(raw.trigger_time) * 1000),
    status: raw.status,
    guardians: [...raw.guardians],
    guardianVotes: raw.guardian_votes,
  };
}

/**
 * Deep-clones a `Will`, including its `beneficiaries`/`guardians` arrays and
 * the `lastCheckin`/`triggerTime` `Date` fields. Read-cache hits return the
 * exact cached object, so a caller mutating a returned `Will` (including
 * calling `setTime` on a `Date` field) would otherwise corrupt the cache for
 * every subsequent read of the same will (#187, #399).
 */
function cloneWill(will: Will): Will {
  return {
    ...will,
    beneficiaries: will.beneficiaries.map((beneficiary) => ({ ...beneficiary })),
    guardians: [...will.guardians],
    lastCheckin: new Date(will.lastCheckin.getTime()),
    triggerTime: will.triggerTime === null ? null : new Date(will.triggerTime.getTime()),
  };
}

function mapWillList(raw: unknown): Will[] {
  if (!Array.isArray(raw)) {
    throw new SoroWillError(
      'SoroWill expected a list of wills from the contract response but received something else. ' +
        'This usually means the deployed contract spec and this SDK version have drifted apart.',
    );
  }
  return sortWillsById(raw.map(mapWill));
}

/**
 * Sorts wills ascending by numeric `will_id`. The contract does not guarantee
 * list order, so the SDK enforces it client-side: pagination cursors are
 * indexes into this sorted list, which keeps pages stable across calls
 * (no duplicates or skips as long as the underlying set is unchanged).
 */
function sortWillsById(wills: Will[]): Will[] {
  return wills.sort((a, b) => {
    const x = BigInt(a.id);
    const y = BigInt(b.id);
    return x < y ? -1 : x > y ? 1 : 0;
  });
}

// === Beneficiary scale conversion

/**
 * The SDK's public `Beneficiary.percentage` is on a 0-100 scale, but the
 * deployed contract's `Beneficiary` struct stores `basis_points` (0-10,000,
 * where 1 bp = 0.01%) and its `distribute()` divides each share by 10,000.
 * Multiplying by this factor converts an SDK percentage into the contract's
 * basis-point representation, so a 30% share binds on-chain as
 * `basis_points = 3000` rather than `30`.
 */
const PERCENT_TO_BASIS_POINTS = 100;

/** Maps SDK beneficiaries (0-100 `percentage`) to the contract's `{ address, basis_points }` shape. */
function toContractBeneficiaries(
  beneficiaries: Beneficiary[],
): Array<{ address: string; basis_points: number }> {
  return beneficiaries.map((beneficiary) => ({
    address: beneficiary.address,
    basis_points: beneficiary.percentage * PERCENT_TO_BASIS_POINTS,
  }));
}

/**
 * Maps the contract's `{ address, basis_points }` beneficiaries back to the
 * SDK's 0-100 `percentage` scale (the inverse of {@link toContractBeneficiaries}).
 * Entries already carrying a `percentage` are passed through unchanged. The SDK
 * only ever writes whole percentages, so a `basis_points` value that is not a
 * multiple of 100 cannot be represented and is rejected rather than rounded.
 */
function fromContractBeneficiaries(beneficiaries: readonly unknown[]): Beneficiary[] {
  return beneficiaries.map((entry) => {
    const { address, basis_points: basisPoints, percentage } = entry as {
      address: string;
      basis_points?: unknown;
      percentage?: number;
    };
    if (basisPoints === undefined) {
      return { address, percentage: percentage as number };
    }
    const bp = Number(basisPoints);
    if (!Number.isInteger(bp) || bp % PERCENT_TO_BASIS_POINTS !== 0) {
      throw new SoroWillError(
        `SoroWill received beneficiary basis_points ${String(basisPoints)} for ${address}, which is not a ` +
          'whole percentage (a multiple of 100) and cannot be represented on the SDK\'s 0-100 percentage scale.',
      );
    }
    return { address, percentage: bp / PERCENT_TO_BASIS_POINTS };
  });
}

/**
 * Shape of an individual event record as returned by this SDK's own
 * polling/WebSocket event-subscription protocol (see {@link SoroWillClient.subscribeToEvents}).
 * This is distinct from `@stellar/stellar-sdk`'s `rpc.Api` event types —
 * events arrive here already JSON-decoded from either an HTTP poll response
 * or a WebSocket message.
 */
interface RawEventRecord {
  id?: string;
  pagingToken?: string;
  ledger?: number;
  ledgerClosedAt?: string;
  contractId?: string;
  txHash?: string;
  type?: string;
  topics?: unknown[];
  topic?: unknown[];
  value?: unknown;
}

function mapEventRecord(record: RawEventRecord, fallbackContractId: string): SoroWillEvent {
  const cursor = record.pagingToken ?? record.id ?? '';
  return {
    id: record.id ?? cursor,
    cursor,
    ledger: record.ledger ?? null,
    ledgerClosedAt: record.ledgerClosedAt ? new Date(record.ledgerClosedAt) : null,
    contractId: record.contractId ?? fallbackContractId,
    txHash: record.txHash ?? null,
    type: record.type ?? null,
    topics: record.topics ?? record.topic ?? [],
    value: record.value,
    raw: record,
  };
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new InvalidCursorError(cursor);
  }
  return Number(cursor);
}

function normalizePositiveInteger(value: number | undefined, label: string): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidPaginationOptionsError(label, value);
  }
  return value;
}

/**
 * Validates that `amount` is a string representing a positive integer before
 * it is passed to `BigInt()`. Throws {@link SoroWillInvalidAmountError} for
 * zero, negative, or malformed (non-numeric) strings so callers get a clear,
 * SDK-level error rather than a raw `SyntaxError` or a wasted RPC round-trip.
 */
function validateAmount(amount: string): bigint {
  // Only decimal digit strings with no leading minus or decimals are valid.
  // Must be at least one character, all digits, and the parsed value > 0.
  if (!/^\d+$/.test(amount)) {
    throw new SoroWillInvalidAmountError(amount);
  }
  const value = BigInt(amount);
  if (value <= 0n) {
    throw new SoroWillInvalidAmountError(amount);
  }
  return value;
}

export class SoroWillInvalidIdError extends SoroWillError {
  constructor(willId: unknown) {
    super(`Invalid willId: '${String(willId)}'. Expected a non-negative integer string.`);
    this.name = 'SoroWillInvalidIdError';
  }
}

/** Validates a `willId` string and converts it to a `bigint`, throwing {@link SoroWillInvalidIdError} for malformed ids. */
export function parseWillId(willId: string): bigint {
  if (typeof willId !== 'string' || !/^\d+$/.test(willId)) {
    throw new SoroWillInvalidIdError(willId);
  }
  return BigInt(willId);
}

/**
 * Validates that a day-count parameter (e.g. `checkinPeriodDays` or
 * `gracePeriodDays`) is a positive integer before it is converted to
 * `BigInt`. Throws a clear, SDK-level {@link SoroWillError} naming the
 * offending parameter instead of letting `BigInt()` surface a cryptic
 * `RangeError` such as *"The number 90.5 cannot be converted to a BigInt
 * because it is not an integer"*.
 *
 * @param value - The numeric value to validate.
 * @param paramName - Human-readable parameter name used in the error message.
 * @returns The value as a `bigint`.
 * @throws {SoroWillError} If `value` is not a positive integer.
 */
function validateDays(value: number, paramName: string): bigint {
  if (!Number.isInteger(value) || value <= 0) {
    throw new InvalidDayCountError(paramName, value);
  }
  return BigInt(value);
}

function getDefaultEnv(): EnvSource {
  if (typeof process !== 'undefined' && process.env) {
    return process.env as EnvSource;
  }
  return {};
}

/**
 * A client for interacting with a deployed SoroWill contract from
 * TypeScript. Read methods (`getWill`, `getWillsByOwner`,
 * `getWillsByBeneficiary`) work without a connected wallet. All other
 * methods sign and submit a transaction via the configured wallet adapter.
 */
export class SoroWillClient {
  private readonly server: SoroWillRpcServer;
  private readonly rpcPool: RpcEndpointPool;
  private readonly contract: Contract;
  private readonly networkPassphrase: string;
  private readonly network: SoroWillNetwork;
  private readonly hooks: HookManager;
  private readonly wallet: WalletAdapter;
  private readonly pollAttempts: number;
  private readonly specOverride: ContractSpecLike | Promise<ContractSpecLike> | undefined;
  private readonly specJsonOverride: Uint8Array | undefined;
  private readonly eventSubscription?: WillEventSubscription;
  private readonly eventRpcUrl: string;
  private readonly eventStreamUrl: string | undefined;
  private readonly defaultPollIntervalMs: number;
  private readonly webSocketFactory: ((url: string) => WebSocketLike) | undefined;
  private readonly fetchImpl: FetchImplementation;
  private readonly queue: RequestQueue;
  /** Tail of the per-account write chain; see {@link SoroWillClient.serializeWrite}. */
  private writeChain: Promise<unknown> = Promise.resolve();
  private readonly inFlightTracker: InFlightTracker;
  private readonly timeoutMs: number;
  private readonly readCache: ReadCache | undefined;
  private readonly retryOptions: RpcRetryOptions;
  private specPromise: Promise<InstanceType<typeof Spec>> | undefined;
  private readonly debug: boolean;
  private readonly debugLogger: DebugLogger;
  private readonly autoFeeBumpOnTimeout: boolean;
  private readonly transactionTimeoutSeconds: number;

  constructor(options: SoroWillClientOptions) {
    const config = NETWORK_CONFIG[options.network];
    const rpcUrl = options.rpcUrl ?? config.rpcUrls[0]!;

    // #153: Wrap the underlying Contract constructor error with a clear SDK-level
    // error so callers see a SoroWill-specific message rather than a raw StrKey
    // decoding failure.
    try {
      this.contract = new Contract(options.contractId);
    } catch (originalError) {
      throw new InvalidContractIdError(options.contractId ?? '', { cause: originalError });
    }

    this.server =
      options.rpcServer ??
      new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') });
    this.networkPassphrase = options.networkPassphrase ?? config.networkPassphrase;
    this.network = options.network;
    this.hooks = options.hooks ?? new HookManager();
    this.wallet = options.wallet ?? getDefaultWalletAdapter();
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
    if (!Number.isInteger(this.pollAttempts) || this.pollAttempts <= 0) {
      throw new RangeError('pollAttempts must be a positive integer');
    }
    this.specOverride = options.spec;
    this.specJsonOverride = options.specJson;
    this.eventRpcUrl = options.eventRpcUrl ?? rpcUrl;
    this.eventStreamUrl = options.eventStreamUrl;
    this.defaultPollIntervalMs = options.defaultPollIntervalMs ?? 5_000;
    if (!Number.isFinite(this.defaultPollIntervalMs) || this.defaultPollIntervalMs <= 0) {
      throw new RangeError('defaultPollIntervalMs must be a finite number greater than zero');
    }
    this.webSocketFactory = options.webSocketFactory;
    this.fetchImpl = options.fetch ?? fetch;

    this.rpcPool = new RpcEndpointPool(options.rpcUrls ?? config.rpcUrls, options.rpcServer);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be greater than zero');
    }
    this.queue = new RequestQueue({
      ...(options.maxConcurrentRequests === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrentRequests }),
      ...(options.requestsPerSecond === undefined
        ? {}
        : { requestsPerSecond: options.requestsPerSecond }),
    });
    this.inFlightTracker = new InFlightTracker();
    this.readCache = options.readCache === false ? undefined : new ReadCache(options.readCache);
    this.retryOptions = { ...DEFAULT_RETRY_OPTIONS, ...options.retry };
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor } = this.retryOptions;
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) {
      throw new RangeError('retry.maxAttempts must be a positive integer');
    }
    if (!Number.isFinite(initialDelayMs) || initialDelayMs < 0) {
      throw new RangeError('retry.initialDelayMs must be a finite, non-negative number');
    }
    if (!Number.isFinite(maxDelayMs) || maxDelayMs < 0) {
      throw new RangeError('retry.maxDelayMs must be a finite, non-negative number');
    }
    if (!Number.isFinite(backoffFactor) || backoffFactor < 1) {
      throw new RangeError('retry.backoffFactor must be a finite number of at least 1');
    }
    this.debug = options.debug ?? false;
    this.debugLogger = new DebugLogger(this.debug);
    this.autoFeeBumpOnTimeout = options.autoFeeBumpOnTimeout ?? false;
    this.transactionTimeoutSeconds = options.transactionTimeoutSeconds ?? 30;
    if (!Number.isFinite(this.transactionTimeoutSeconds) || this.transactionTimeoutSeconds <= 0) {
      throw new RangeError('transactionTimeoutSeconds must be a finite number greater than zero');
    }

    if (this.readCache && options.eventSource) {
      this.eventSubscription = options.eventSource.subscribe((event) => {
        void this.readCache?.invalidateByWillId(event.willId);
      });
    }
  }

  // -----------------------------------------------------------------------
  // Static factory
  // -----------------------------------------------------------------------

  /**
   * Constructs a client from environment variables.
   *
   * Expected variables:
   * - `SOROWILL_NETWORK`
   * - `SOROWILL_CONTRACT_ID`
   * - `SOROWILL_RPC_URL` (optional)
   * - `SOROWILL_NETWORK_PASSPHRASE` (optional)
   * - `SOROWILL_EVENT_RPC_URL` (optional)
   * - `SOROWILL_EVENT_STREAM_URL` (optional)
   * - `SOROWILL_EVENTS_POLL_INTERVAL_MS` (optional)
   *
   * @throws {Error} If `SOROWILL_NETWORK` is not `"testnet"` or `"mainnet"`.
   * @throws {Error} If `SOROWILL_CONTRACT_ID` is not set.
   */
  static fromEnv(env: EnvSource = getDefaultEnv()): SoroWillClient {
    const network = env.SOROWILL_NETWORK;
    if (network !== 'testnet' && network !== 'mainnet') {
      throw new Error('SOROWILL_NETWORK must be set to "testnet" or "mainnet"');
    }

    const contractId = env.SOROWILL_CONTRACT_ID;
    if (!contractId) {
      throw new Error('SOROWILL_CONTRACT_ID must be set');
    }

    const pollInterval = env.SOROWILL_EVENTS_POLL_INTERVAL_MS
      ? Number(env.SOROWILL_EVENTS_POLL_INTERVAL_MS)
      : undefined;
    if (pollInterval !== undefined && (!Number.isFinite(pollInterval) || pollInterval <= 0)) {
      throw new Error('SOROWILL_EVENTS_POLL_INTERVAL_MS must be a finite positive number');
    }

    return new SoroWillClient({
      network,
      contractId,
      ...(env.SOROWILL_RPC_URL ? { rpcUrl: env.SOROWILL_RPC_URL } : {}),
      ...(env.SOROWILL_NETWORK_PASSPHRASE ? { networkPassphrase: env.SOROWILL_NETWORK_PASSPHRASE } : {}),
      ...(env.SOROWILL_EVENT_RPC_URL ? { eventRpcUrl: env.SOROWILL_EVENT_RPC_URL } : {}),
      ...(env.SOROWILL_EVENT_STREAM_URL ? { eventStreamUrl: env.SOROWILL_EVENT_STREAM_URL } : {}),
      ...(pollInterval !== undefined ? { defaultPollIntervalMs: pollInterval } : {}),
    });
  }

  /**
   * Convenience constructor that targets a known network using the
   * **maintainer-managed default contract address** for that network.
   *
   * This is the recommended way to get started quickly. Any option accepted
   * by the `SoroWillClient` constructor can be passed as `overrides` —
   * including `contractId` if you need to point at a specific deployment
   * (e.g. a staging contract or your own fork).
   *
   * ```ts
   * // Simplest case — uses the default testnet contract:
   * const client = SoroWillClient.forNetwork('testnet');
   *
   * // Override the contract address (e.g. after a redeploy):
   * const client = SoroWillClient.forNetwork('testnet', {
   *   contractId: 'CNEW...',
   * });
   * ```
   *
   * **Important — default contract ID freshness:**
   * The default `contractId` values in {@link DEFAULT_CONTRACT_IDS} are
   * baked into each SDK release. If the SoroWill contract is redeployed
   * between SDK releases, you **must** pass `contractId` explicitly in
   * `overrides` until a new SDK version is published with the updated
   * address. Track redeployments in the contracts repo's
   * `deployments/` directory:
   * https://github.com/SoroWill/sorowill-contracts/tree/main/deployments
   *
   * @param network - The target Stellar network (`'testnet'` or `'mainnet'`).
   * @param overrides - Any `SoroWillClientOptions` to merge on top of the
   *   per-network defaults. `network` is always taken from the first argument
   *   and cannot be overridden here.
   *
   * @throws {Error} If `network` is `'mainnet'` and no mainnet contract has
   *   been deployed yet (i.e. the default address is still the placeholder).
   */
  static forNetwork(
    network: SoroWillNetwork,
    overrides?: Partial<Omit<SoroWillClientOptions, 'network'>>,
  ): SoroWillClient {
    const defaultContractId = DEFAULT_CONTRACT_IDS[network];

    // Guard against the mainnet placeholder until a real deployment exists.
    if (!defaultContractId && !overrides?.contractId) {
      throw new Error(
        `No default contract address is available for network "${network}" yet. ` +
          'Pass contractId explicitly in the overrides argument.',
      );
    }

    return new SoroWillClient({
      ...overrides,
      network,
      contractId: overrides?.contractId ?? defaultContractId,
    });
  }

  // -----------------------------------------------------------------------
  // Public: state-changing methods
  // -----------------------------------------------------------------------

  /**
   * Locks `params.amount` of `params.token` and creates a new will.
   *
   * @returns The newly created will's ID and the transaction hash.
   * @throws {SoroWillError} If the transaction simulation fails or returns no result.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors (e.g. InvalidPercentagesError,
   *   TooManyBeneficiariesError, ZeroAmountError).
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async createWill(
    params: CreateWillParams,
    options?: RequestOptions,
  ): Promise<{ willId: string; txHash: string }> {
    if (hasDuplicateBeneficiaries(params.beneficiaries)) {
      throw new BeneficiaryValidationError('Invalid beneficiaries: duplicate beneficiary addresses are not allowed.');
    }
    if (!validateBeneficiaries(params.beneficiaries)) {
      throw new BeneficiaryValidationError(
        'Invalid beneficiaries: list must be 1–10 entries, every percentage must be a positive integer, and percentages must sum to exactly 100.',
      );
    }
    // #156: Validate guardians count synchronously before any RPC round-trip.
    if (params.guardians.length > MAX_GUARDIANS) {
      throw new TooManyGuardiansError(params.guardians.length, MAX_GUARDIANS);
    }
    if (!StrKey.isValidContract(params.token)) {
      throw new InvalidContractIdError(params.token);
    }
    const owner = await this.getWalletPublicKey();
    const seenGuardians = new Set<string>();
    for (const guardian of params.guardians) {
      if (!StrKey.isValidEd25519PublicKey(guardian)) {
        throw new GuardianValidationError('invalid_address', guardian);
      }
      if (seenGuardians.has(guardian)) {
        throw new GuardianValidationError('duplicate', guardian);
      }
      if (guardian === owner) {
        throw new GuardianValidationError('owner_is_guardian', guardian);
      }
      seenGuardians.add(guardian);
    }
    const { txHash, returnValue } = await this.invoke(
      'create_will',
      {
        owner,
        token: params.token,
        amount: validateAmount(params.amount),
        beneficiaries: toContractBeneficiaries(params.beneficiaries),
        checkin_period_days: validateDays(params.checkinPeriodDays, 'checkinPeriodDays'),
        grace_period_days: validateDays(params.gracePeriodDays, 'gracePeriodDays'),
        guardians: params.guardians,
      },
      options,
    );
    if (!returnValue) {
      throw new SoroWillError('create_will transaction succeeded but returned no will id');
    }
    const spec = await this.getSpec(options);
    const decoded = spec.funcResToNative('create_will', returnValue);
    if (typeof decoded !== 'bigint') {
      throw new SoroWillError(
        `SoroWill expected create_will to return a numeric will id but received a ${typeof decoded}. ` +
          'This usually means the deployed contract spec and this SDK version have drifted apart.',
      );
    }
    const willId = decoded.toString();
    return { willId, txHash };
  }

  /** Resets the check-in countdown for `willId`. */
  async checkIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    parseWillId(willId);
    const owner = await this.getWalletPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's check_in function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke(
      'check_in',
      { will_id: parseWillId(willId), owner },
      options,
    );
    return {
      txHash,
      nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000),
    };
  }

  /**
   * Starts the grace period for `willId` once the check-in deadline has passed.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {CheckinNotDueError} If the check-in deadline has not passed.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async triggerWill(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke('trigger_will', { will_id: parseWillId(willId) }, options);
    return { txHash };
  }

  /** Cancels an in-progress trigger during the grace period, resetting the countdown. */
  async emergencyCheckIn(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; nextDeadline: Date }> {
    parseWillId(willId);
    const owner = await this.getWalletPublicKey();
    // checkin_period_days is a stored will property not returned by the
    // contract's emergency_checkin function, so a separate getWill() read is
    // unavoidable in order to compute the nextDeadline return value.
    const will = await this.getWill(willId, options);
    const { txHash, createdAt } = await this.invoke(
      'emergency_checkin',
      { will_id: parseWillId(willId), owner },
      options,
    );
    return {
      txHash,
      nextDeadline: new Date((createdAt + will.checkinPeriodDays * 86_400) * 1000),
    };
  }

  /**
   * Distributes the will's balance to all beneficiaries once the grace period has elapsed.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {WillNotTriggeredError} If the will has not been triggered.
   * @throws {GracePeriodNotExpiredError} If the grace period has not yet expired.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async releaseInheritance(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    const { txHash } = await this.invoke(
      'release_inheritance',
      { will_id: parseWillId(willId) },
      options,
    );
    return { txHash };
  }

  /** Cancels the will and withdraws the full balance back to the owner. */
  async cancelWill(
    willId: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; refundAmount: string }> {
    parseWillId(willId);
    const owner = await this.getWalletPublicKey();
    const { txHash, returnValue } = await this.invoke('cancel_will', {
      will_id: parseWillId(willId),
      owner,
    }, options);
    // cancel_will returns the refunded balance on success. Decode it from the
    // transaction return value to avoid an extra getWill() round-trip.
    if (returnValue) {
      const spec = await this.getSpec(options);
      const refundAmount = spec.funcResToNative('cancel_will', returnValue) as bigint;
      return { txHash, refundAmount: refundAmount.toString() };
    }
    // Fallback for older contract versions that don't return the balance.
    const will = await this.getWill(willId, options);
    return { txHash, refundAmount: will.balance };
  }

  /** Replaces the beneficiary list for a will before it has been triggered. */
  async updateBeneficiaries(
    params: UpdateBeneficiariesParams,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    parseWillId(params.willId);
    if (hasDuplicateBeneficiaries(params.beneficiaries)) {
      throw new BeneficiaryValidationError('Invalid beneficiaries: duplicate beneficiary addresses are not allowed.');
    }
    if (!validateBeneficiaries(params.beneficiaries)) {
      throw new BeneficiaryValidationError(
        'Invalid beneficiaries: list must be 1–10 entries, every percentage must be a positive integer, and percentages must sum to exactly 100.',
      );
    }
    const owner = await this.getWalletPublicKey();
    const { txHash } = await this.invoke(
      'update_beneficiaries',
      { will_id: parseWillId(params.willId), owner, beneficiaries: toContractBeneficiaries(params.beneficiaries) },
      options,
    );
    return { txHash };
  }

  /** Adds more of the will's token to its locked balance. */
  async topUp(
    willId: string,
    amount: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string }> {
    parseWillId(willId);
    const owner = await this.getWalletPublicKey();
    const { txHash } = await this.invoke('top_up', {
      will_id: parseWillId(willId),
      owner,
      amount: validateAmount(amount),
    }, options);
    return { txHash };
  }

  // -----------------------------------------------------------------------
  // Public: transaction polling
  // -----------------------------------------------------------------------

  /**
   * Polls for the final status of a submitted transaction and returns its
   * `createdAt` ledger timestamp and contract return value.
   *
   * This is the same polling-and-status-handling logic used internally by
   * all state-changing methods. Consumers who submit transactions through a
   * custom signing flow (e.g. using lower-level
   * `buildTransaction`/`submitSignedTransaction` primitives) can call this
   * directly instead of re-implementing the polling loop themselves.
   *
   * @param txHash - The hash returned by `sendTransaction`.
   * @param options - Optional per-call timeout and abort signal.
   * @returns The ledger creation timestamp and the contract return value, if any.
   * @throws {SoroWillError} If the transaction does not reach `SUCCESS` status.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   */
  async waitForTransaction(
    txHash: string,
    options?: RequestOptions,
  ): Promise<{ createdAt: number; returnValue: xdr.ScVal | undefined }> {
    const txResponse = await this.rpc(
      () => this.server.pollTransaction(txHash, { attempts: this.pollAttempts }),
      options,
    );

    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new InvokeFailedError(txHash, `transaction did not succeed`, {
        status: txResponse.status,
        resultXdr: (txResponse as unknown as Record<string, unknown>).resultXdr ?? null,
        diagnosticEventsXdr: (txResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
        txHash,
      });
    }

    return {
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  /**
   * Proactively check whether the configured RPC endpoint is reachable.
   * Useful for showing a 'network unavailable' banner before attempting a real call.
   * Never throws — network failures resolve to `false` rather than propagating an exception.
   *
   * The call goes through the request queue with the client's timeout and RPC failover.
   * A server that does not implement `getHealth` is reported as not healthy (`false`).
   *
   * @returns `true` only if the RPC server reports `status: 'healthy'`, `false` otherwise.
   */
  async isHealthy(options?: RequestOptions): Promise<boolean> {
    try {
      const response = await this.rpc(
        () =>
          this.rpcPool.withFailover((server) => {
            if (typeof server.getHealth !== 'function') {
              throw new SoroWillError('The configured RPC server does not support getHealth');
            }
            return server.getHealth();
          }),
        options,
      );
      return response?.status === 'healthy';
    } catch {
      // Network failures, timeouts, or any other errors mean the server is not healthy
      return false;
    }
  }

  /**
   * Returns the currently active RPC endpoint URL.
   *
   * When multiple RPC endpoints are configured via `rpcUrls`, the pool tracks
   * which endpoint is actively in use. This is useful for debugging regional
   * outages, comparing endpoint reliability, or understanding which backup
   * endpoint the client failed over to.
   *
   * @throws {Error} if no RPC endpoints are configured (which is prevented by
   * the RpcEndpointPool constructor, so this should not occur in practice)
   *
   * @returns the currently active RPC endpoint URL
   */
  getActiveRpcUrl(): string {
    return this.rpcPool.getActiveRpcUrl();
  }

  async getWill(willId: string, options?: RequestOptions): Promise<Will> {
    const canonicalWillId = parseWillId(willId).toString();
    const cacheKey = createReadCacheKey('get_will', { willId: canonicalWillId });
    if (this.readCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will>(cacheKey);
      if (cached !== undefined) {
        return cloneWill(cached);
      }
    }
    const raw = await this.read<unknown>('get_will', { will_id: BigInt(canonicalWillId) }, options);
    const will = mapWill(raw);
    this.readCache?.set(cacheKey, cloneWill(will), [canonicalWillId]);
    return will;
  }

  /** Lists every will owned by `owner`. Does not require a connected wallet. */
  async getWillsByOwner(owner: string, options?: RequestOptions): Promise<Will[]>;
  /** Lists every will owned by `owner`, one client-side page at a time. Does not require a connected wallet. */
  async getWillsByOwner(
    owner: string,
    options: PaginationOptions & RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByOwner(
    owner: string,
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const cacheKey = createReadCacheKey('get_wills_by_owner', { owner });
    if (this.readCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will[]>(cacheKey);
      if (cached !== undefined) {
        return this.paginate(cached.map(cloneWill), options);
      }
    }
    const raw = await this.read<unknown>('get_wills_by_owner', { owner }, options);
    const wills = mapWillList(raw);
    this.readCache?.set(cacheKey, wills.map(cloneWill), wills.map((will) => will.id));
    return this.paginate(wills, options);
  }

  /** Lists every will `beneficiary` is named in. Does not require a connected wallet. */
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: RequestOptions,
  ): Promise<Will[]>;
  /** Lists every will `beneficiary` is named in, one client-side page at a time. Does not require a connected wallet. */
  async getWillsByBeneficiary(
    beneficiary: string,
    options: PaginationOptions & RequestOptions,
  ): Promise<PaginatedWillsResult>;
  async getWillsByBeneficiary(
    beneficiary: string,
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Promise<Will[] | PaginatedWillsResult> {
    const cacheKey = createReadCacheKey('get_wills_by_beneficiary', { beneficiary });
    if (this.readCache) {
      await this.readCache.ready();
      const cached = this.readCache.get<Will[]>(cacheKey);
      if (cached !== undefined) {
        return this.paginate(cached.map(cloneWill), options);
      }
    }
    const raw = await this.read<unknown>(
      'get_wills_by_beneficiary',
      { beneficiary },
      options,
    );
    const wills = mapWillList(raw);
    this.readCache?.set(cacheKey, wills.map(cloneWill), wills.map((will) => will.id));
    return this.paginate(wills, options);
  }

  /**
   * Applies optional client-side pagination to an already-fetched list of
   * wills. Returns the plain list unchanged when neither `pageSize` nor
   * `cursor` is present on `options`, so callers who don't ask for
   * pagination keep getting a plain `Will[]`.
   *
   * Sort order guarantee: wills are always returned sorted ascending by
   * `will_id`, so cursors are consistent across calls.
   */
  private paginate(
    wills: Will[],
    options?: (PaginationOptions & RequestOptions) | RequestOptions,
  ): Will[] | PaginatedWillsResult {
    const paginationOptions = options as PaginationOptions | undefined;
    if (!paginationOptions || (paginationOptions.pageSize === undefined && paginationOptions.cursor === undefined)) {
      return wills;
    }
    const pageSize = normalizePositiveInteger(paginationOptions.pageSize, 'pageSize') ?? wills.length;
    const start = parseCursor(paginationOptions.cursor);
    const page = wills.slice(start, start + pageSize);
    const nextIndex = start + page.length;
    return { wills: page, nextCursor: nextIndex < wills.length ? String(nextIndex) : null };
  }

  /**
   * Casts a guardian vote to force an early release of `willId`. Once 2 of
   * the will's guardians have voted, the balance is released automatically.
   *
   * @returns The transaction hash.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillNotFoundError} If the will does not exist.
   * @throws {NotGuardianError} If the caller is not a guardian of this will.
   * @throws {AlreadyVotedError} If this guardian has already voted.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async guardianTrigger(willId: string, options?: RequestOptions): Promise<{ txHash: string }> {
    parseWillId(willId);
    const guardian = await this.getWalletPublicKey();
    const { txHash, returnValue, events } = await this.invoke('guardian_trigger', {
      will_id: parseWillId(willId),
      guardian,
    }, options);

    let votesSoFar = 0;
    let released = false;

    // Decode contract events emitted during this transaction.
    if (events && events.length > 0) {
      for (const event of events) {
        const topics = event.topics ?? [];
        if (topics.includes('gvote')) {
          votesSoFar = (event.data as { votes?: number })?.votes ?? 1;
        }
        if (topics.includes('released')) {
          released = true;
        }
      }
    }

    // Fallback: try decoding the return value if events weren't available.
    if (!released && !votesSoFar && returnValue) {
      try {
        const spec = await this.getSpec(options);
        const result = spec.funcResToNative('guardian_trigger', returnValue) as {
          votes?: number;
          released?: boolean;
        } | bigint;
        if (typeof result === 'object' && result !== null) {
          votesSoFar = result.votes ?? 0;
          released = result.released ?? false;
        }
      } catch {
        // Return value isn't decodable as a tuple; events are the primary source.
      }
    }

    void votesSoFar;
    void released;
    return { txHash };
  }

  /**
   * Simulates, signs, and submits a raw contract call given by its native method name and arguments.
   * Arguments use the native names and values accepted by the deployed contract spec.
   *
   * Soroban transactions may contain only a single `InvokeHostFunction` operation, so a batch
   * must contain exactly one operation; multiple calls cannot be combined into one atomic
   * transaction and must be submitted separately.
   *
   * @returns The transaction hash and creation timestamp.
   * @throws {RangeError} If the batch contains zero operations.
   * @throws {UnsupportedBatchSizeError} If the batch contains more than one operation.
   * @throws {SoroWillError} If the transaction simulation/submission fails.
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout.
   * @throws {WillContractError} Mapped contract-level errors from any operation in the batch.
   * @throws {Error} If the wallet is not connected or fails to sign.
   */
  async batch(
    operations: readonly BatchOperation[],
    options?: RequestOptions,
  ): Promise<BatchResult> {
    if (operations.length === 0) {
      throw new RangeError('A batch must contain at least one operation');
    }
    if (operations.length > 1) {
      throw new UnsupportedBatchSizeError(operations.length);
    }
    const hookContexts = operations.map(({ method, args }) => ({
      before: {
        method,
        args,
        timestamp: new Date().toISOString(),
      } satisfies BeforeInvokeContext,
      startTime: Date.now(),
    }));
    for (const { before } of hookContexts) {
      const proceed = await this.hooks.runBeforeInvoke(before);
      if (!proceed) {
        throw new SoroWillError(`SoroWill invocation aborted by beforeInvoke hook for ${before.method}`);
      }
    }

    let txHash: string | null = null;
    let error: string | null = null;
    try {
      return await this.serializeWrite(async () => {
        const spec = await this.getSpec(options);
        const contractOperations = operations.map(({ method, args }) =>
          this.contract.call(method, ...spec.funcArgsToScVals(method, args)),
        );

        const publicKey = await this.getWalletPublicKey();
        const account = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
          options,
        );
        const builder = new TransactionBuilder(account, {
          fee: BASE_FEE,
          networkPassphrase: this.networkPassphrase,
        });
        for (const op of contractOperations) {
          builder.addOperation(op);
        }
        const builtTx = builder.setTimeout(this.transactionTimeoutSeconds).build();

        const prepared = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
          options,
        );

        assertPreparedTransactionMatchesIntendedOperation({
          intendedTransactionXdr: builtTx.toXDR(),
          preparedTransactionXdr: prepared.toXDR(),
          networkPassphrase: this.networkPassphrase,
          context: 'batch',
        });

        const signedTxXdr = await this.wallet.signTransaction(prepared.toXDR(), {
          networkPassphrase: this.networkPassphrase,
        });
        const result = await this.submitSignedTransaction(signedTxXdr, options);
        txHash = result.txHash;
        return { txHash: result.txHash, createdAt: result.createdAt };
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      for (const { before, startTime } of hookContexts) {
        await this.hooks.runAfterInvoke({
          method: before.method,
          args: before.args,
          timestamp: new Date().toISOString(),
          txHash,
          error,
          durationMs: Date.now() - startTime,
        });
      }
    }
  }

  /**
   * Builds a SEP-7 deep-link URI for a state-changing contract call, so a
   * mobile wallet can sign it outside the browser extension flow.
   *
   * @returns The `web+stellar:tx?...` URI string.
   * @throws {Error} If the RPC call to build the transaction fails.
   */
  async buildSep7SigningUri(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey: string,
    options: BuildSep7TxUriOptions,
  ): Promise<string> {
    const builtTx = await this.buildInvocationTransaction(method, args, sourcePublicKey);
    const prepared = await this.prepareInvocation(method, args, builtTx, sourcePublicKey);
    assertPreparedTransactionMatchesIntendedOperation({
      intendedTransactionXdr: builtTx.toXDR(),
      preparedTransactionXdr: prepared.toXDR(),
      networkPassphrase: this.networkPassphrase,
      context: `buildSep7SigningUri(${method})`,
    });
    return buildSep7TxUri(prepared.toXDR(), {
      ...options,
      networkPassphrase: options.networkPassphrase ?? this.networkPassphrase,
    });
  }

  /**
   * Simulates `method` with `args` and returns the Soroban resource fee the
   * network would charge, without signing or submitting anything. Useful for
   * showing a fee estimate in a UI before the user commits to a transaction.
   *
   * `resourceFee` is the operation-specific Soroban resource cost (CPU, RAM,
   * ledger I/O, storage). `totalFee` adds the base inclusion fee, giving the
   * minimum total fee the network will accept for this call.
   *
   * @see https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
   */
  async previewFee(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ resourceFee: string; totalFee: string }> {
    try {
      const spec = await this.getSpec(options);
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const tx = this.buildInvocationEnvelope([operation], new Account(NULL_ACCOUNT, '0'));

      const simulation = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
        options,
      );
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SimulationError(method, simulation.error);
      }
      return {
        resourceFee: simulation.minResourceFee,
        totalFee: (BigInt(BASE_FEE) + BigInt(simulation.minResourceFee)).toString(),
      };
    } catch (error) {
      throw mapContractError(error);
    }
  }

  /**
   * Subscribes to SoroWill contract events, delivering each decoded event to
   * `listener` as it arrives. Prefers a WebSocket stream (via
   * `webSocketFactory` and `eventStreamUrl`) when both are configured,
   * automatically falling back to HTTP polling (via `fetch` and
   * `eventRpcUrl`) if the WebSocket connection fails to open. Pass
   * `{ transport: 'polling' }` to skip WebSocket entirely, or
   * `{ transport: 'websocket' }` to require it — this throws
   * {@link WebSocketNotConfiguredError} instead of silently falling back to
   * polling if `webSocketFactory`/`eventStreamUrl` aren't configured.
   *
   * @returns A handle that can be used to close the subscription.
   */
  async subscribeToEvents(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions = {},
  ): Promise<EventSubscription> {
    const wantsWebSocket = options.transport !== 'polling';
    const canUseWebSocket = wantsWebSocket && !!this.webSocketFactory && !!this.eventStreamUrl;

    if (!canUseWebSocket) {
      if (options.transport === 'websocket') {
        throw new WebSocketNotConfiguredError();
      }
      return this.startPollingSubscription(listener, options);
    }

    return new Promise<EventSubscription>((resolve) => {
      const socket = this.webSocketFactory!(this.eventStreamUrl!);
      let settled = false;
      let closed = false;

      const connectTimeoutMs =
        options.websocketConnectTimeoutMs ?? DEFAULT_WEBSOCKET_CONNECT_TIMEOUT_MS;
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConnectTimer = (): void => {
        if (connectTimer !== undefined) {
          clearTimeout(connectTimer);
          connectTimer = undefined;
        }
      };
      if (Number.isFinite(connectTimeoutMs) && connectTimeoutMs > 0) {
        connectTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try {
            socket.close();
          } catch {
            // Best-effort close on a socket that never finished connecting.
          }
          options.onError?.(
            new Error(
              `SoroWill event WebSocket did not open within ${connectTimeoutMs}ms; falling back to polling.`,
            ),
          );
          resolve(this.startPollingSubscription(listener, options));
        }, connectTimeoutMs);
      }

      const subscription: EventSubscription = {
        transport: 'websocket',
        get closed() {
          return closed;
        },
        close: () => {
          if (closed) return;
          closed = true;
          clearConnectTimer();
          try {
            socket.close();
          } catch {
            // Best-effort close; the socket may already be gone.
          }
        },
      };

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearConnectTimer();
        socket.send(
          JSON.stringify({
            type: 'subscribe',
            contractId: this.getContractId(),
            cursor: options.cursor,
          }),
        );
        resolve(subscription);
      };

      socket.onmessage = (event) => {
        if (closed) return;
        try {
          const payload = JSON.parse(event.data) as { result?: { events?: RawEventRecord[] } };
          for (const raw of payload.result?.events ?? []) {
            listener(mapEventRecord(raw, this.getContractId()));
          }
        } catch (err) {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      };

      socket.onerror = () => {
        if (settled) {
          // #210: a drop after the subscription already opened is not
          // auto-recovered (falling back to polling here would silently
          // change transport mid-stream) — surface the error and mark the
          // subscription closed so callers know to react themselves.
          closed = true;
          try {
            socket.close();
          } catch {
            // Best-effort close; the socket may already be gone.
          }
          options.onError?.(new Error('SoroWill event WebSocket stream error'));
          return;
        }
        settled = true;
        clearConnectTimer();
        try {
          socket.close();
        } catch {
          // Best-effort close on a connection that never opened.
        }
        resolve(this.startPollingSubscription(listener, options));
      };

      socket.onclose = () => {
        closed = true;
        if (settled) return;
        settled = true;
        clearConnectTimer();
        resolve(this.startPollingSubscription(listener, options));
      };
    });
  }

  /** Polls for new events on an interval, decoding and delivering each to `listener`. */
  private async startPollingSubscription(
    listener: (event: SoroWillEvent) => void,
    options: EventSubscriptionOptions,
  ): Promise<EventSubscription> {
    const pollIntervalMs = options.pollIntervalMs ?? this.defaultPollIntervalMs;
    let cursor = options.cursor;
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const subscription: EventSubscription = {
      transport: 'polling',
      get closed() {
        return closed;
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
      },
    };

    const poll = async (): Promise<void> => {
      if (closed) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.eventRpcUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getEvents',
            params: {
              filters: [{ contractIds: [this.getContractId()] }],
              pagination: { cursor, limit: options.pageSize },
            },
          }),
        });
        if (!response.ok) {
          throw new SoroWillError(`getEvents poll failed with HTTP status ${response.status}`);
        }
        const payload = (await response.json()) as {
          result?: { events?: RawEventRecord[]; nextCursor?: string };
          error?: { code?: number; message?: string };
        };
        if (payload.error) {
          throw new SoroWillError(
            `getEvents poll failed with JSON-RPC error ${payload.error.code}: ${payload.error.message ?? 'unknown error'}`,
          );
        }
        for (const raw of payload.result?.events ?? []) {
          if (closed) break;
          // Isolate listener failures per event so a throwing listener neither stalls
          // cursor progress nor causes the same events to be redelivered.
          try {
            listener(mapEventRecord(raw, this.getContractId()));
          } catch (listenerError) {
            const eventId = raw.id ?? raw.pagingToken ?? 'unknown';
            options.onError?.(
              new SoroWillError(`Event listener threw for event ${eventId}`, { cause: listenerError }),
            );
          }
        }
        if (payload.result?.nextCursor !== undefined) {
          cursor = payload.result.nextCursor;
        }
      } catch (err) {
        if (controller.signal.aborted) {
          options.onError?.(new RequestTimeoutError(this.timeoutMs));
        } else {
          options.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        clearTimeout(timeout);
        if (!closed) {
          timer = setTimeout(() => void poll(), pollIntervalMs);
        }
      }
    };

    await poll();
    return subscription;
  }

  /** Tears down the client: unsubscribes from any event source, aborts all
   * in-flight tracked operations, and rejects every queued-but-not-yet-started
   * request so nothing continues running in the background after teardown. */
  destroy(): void {
    if (this.eventSubscription) {
      unsubscribeFromWillEvents(this.eventSubscription);
    }
    this.inFlightTracker.clear();
    this.queue.rejectAll(new Error('SoroWillClient destroyed'));
  }

  /**
   * Returns the contract address this client was configured with.
   *
   * Useful when a consumer needs to display which contract a client is
   * connected to (e.g. in a UI or a diagnostic log) without having to hold
   * onto the original `SoroWillClientOptions` object separately.
   */
  getContractId(): string {
    return this.contract.contractId();
  }

  /**
   * Returns the Stellar network this client was configured with.
   *
   * Useful when a consumer needs to make decisions based on which network a
   * client was built for — e.g. displaying "connected to testnet" in a UI,
   * or guarding against accidentally running mainnet logic in a test
   * environment.
   */
  getNetwork(): SoroWillNetwork {
    return this.network;
  }

  /** Lazily fetches and caches the contract's spec from its deployed wasm. */
  private async getSpec(
    options?: RequestOptions,
  ): Promise<InstanceType<typeof Spec>> {
    if (!this.specPromise) {
      if (this.specOverride) {
        this.specPromise = Promise.resolve(this.specOverride) as Promise<InstanceType<typeof Spec>>;
      } else if (this.specJsonOverride) {
        this.specPromise = Promise.resolve(Spec.fromWasm(Buffer.from(this.specJsonOverride)));
      } else {
        // A rejected spec fetch must not stay cached forever — clear it so
        // the next call retries instead of replaying the same failure.
        this.specPromise = this.rpc(
          () => this.server.getContractWasmByContractId(this.contract.contractId()),
          options,
        )
          .then((wasm) => Spec.fromWasm(Buffer.from(wasm)))
          .catch((error: unknown) => {
            this.specPromise = undefined;
            throw error;
          });
      }
    }
    return await this.specPromise;
  }

  /** Simulates a read-only contract call, requiring no connected wallet or signature. */
  private async read<T>(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<T> {
    try {
      const spec = await this.getSpec(options);
      const scArgs = spec.funcArgsToScVals(method, args);
      const operation = this.contract.call(method, ...scArgs);

      const tx = this.buildInvocationEnvelope([operation], new Account(NULL_ACCOUNT, '0'));

      const simulation = await this.withRetry(() =>
        this.rpc(
          () => this.rpcPool.withFailover((server) => server.simulateTransaction(tx)),
          options,
        ),
      );
      if (rpc.Api.isSimulationError(simulation)) {
        throw new SimulationError(method, simulation.error);
      }
      if (rpc.Api.isSimulationRestore(simulation)) {
        throw new SoroWillRestoreRequiredError(
          `SoroWill simulation for ${method} requires ledger-entry restoration before this call can proceed. ` +
            'Build and submit a restoreFootprint operation using the restore preamble on this error, then retry.',
          simulation,
        );
      }
      if (!simulation.result) {
        throw new SoroWillError(`SoroWill simulation for ${method} returned no result`);
      }
      if (simulation.result.retval === undefined || simulation.result.retval === null) {
        throw new SoroWillError(
          `SoroWill simulation for ${method} returned a malformed result: retval is missing. ` +
            'This usually means the RPC node returned an unexpected response shape.',
        );
      }

      return spec.funcResToNative(method, simulation.result.retval) as T;
    } catch (error) {
      throw mapContractError(error);
    }
  }

  /** Builds, simulates, signs, and submits a state-changing contract call. */
  private async invoke(
    method: string,
    args: Record<string, unknown>,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined; events?: Array<{ topics: string[]; data: unknown }> }> {
    const willId = args.will_id === undefined ? undefined : String(args.will_id);
    const run = async (): Promise<{
      txHash: string;
      createdAt: number;
      returnValue: ScVal | undefined;
      events?: Array<{ topics: string[]; data: unknown }>;
    }> => {
    // Run beforeInvoke hooks
    const beforeCtx: BeforeInvokeContext = {
      method,
      args,
      timestamp: new Date().toISOString(),
    };
    const proceed = await this.hooks.runBeforeInvoke(beforeCtx);
    if (!proceed) {
      await this.hooks.runAfterInvoke({
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash: null,
        error: `SoroWill invocation aborted by beforeInvoke hook for ${method}`,
        durationMs: 0,
      });
      throw new SoroWillError(`SoroWill invocation aborted by beforeInvoke hook for ${method}`);
    }

    const startTime = Date.now();
    let txHash: string | null = null;
    let error: string | null = null;

    try {
      const spec = await this.getSpec(options);
      this.debugLogger.logOperationBuild(method, willId);

      const operation = this.contract.call(method, ...spec.funcArgsToScVals(method, args));
      const result = await this.submit([operation], method, options);

      txHash = result.txHash;

      this.debugLogger.logSuccess(
        method,
        willId,
        txHash,
        Date.now() - startTime,
      );

      const afterCtx: AfterInvokeContext = {
        method,
        args,
        timestamp: new Date().toISOString(),
        txHash,
        error: null,
        durationMs: Date.now() - startTime,
      };
      await this.hooks.runAfterInvoke(afterCtx);

      return result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      this.debugLogger.logError(method, willId, err instanceof Error ? err : String(err));
      throw err;
    } finally {
      if (error) {
        const afterCtx: AfterInvokeContext = {
          method,
          args,
          timestamp: new Date().toISOString(),
          txHash,
          error,
          durationMs: Date.now() - startTime,
        };
        try {
          await this.hooks.runAfterInvoke(afterCtx);
        } catch (hookError) {
          this.debugLogger.logError(
            method,
            willId,
            hookError instanceof Error
              ? `afterInvoke hook threw: ${hookError.message}`
              : `afterInvoke hook threw: ${String(hookError)}`,
          );
        }
      }
    }
    };

    return willId === undefined
      ? run()
      : this.inFlightTracker.track(willId, method, run) as Promise<{
          txHash: string;
          createdAt: number;
          returnValue: ScVal | undefined;
          events?: Array<{ topics: string[]; data: unknown }>;
        }>;
  }

  /**
   * Runs state-changing submissions for this client's account strictly one at a
   * time, in call order. Each write loads the account sequence number, signs,
   * submits, and waits for a terminal status (including any RPC retries or
   * fee-bump resubmission) before the next write starts, so a retried operation
   * can never land after an operation that was issued later.
   */
  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeChain.then(operation, operation);
    this.writeChain = result.catch(() => undefined);
    return result;
  }

  /** Builds, signs, submits, and polls a set of operations as one transaction, serialized per account. */
  private submit(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{
    txHash: string;
    createdAt: number;
    returnValue: ScVal | undefined;
    events?: Array<{ topics: string[]; data: unknown }>;
  }> {
    return this.serializeWrite(() => this.submitUnserialized(operations, label, options));
  }

  /** Builds, signs, submits, and polls a set of operations as one transaction. */
  private async submitUnserialized(
    operations: readonly xdr.Operation[],
    label: string,
    options?: RequestOptions,
  ): Promise<{
    txHash: string;
    createdAt: number;
    returnValue: ScVal | undefined;
    events?: Array<{ topics: string[]; data: unknown }>;
  }> {
    options?.signal?.throwIfAborted();

    try {
      await this.assertWalletNetwork({ networkPassphrase: this.networkPassphrase });
      const publicKey = await this.getWalletPublicKey();
      options?.signal?.throwIfAborted();
      let account: Account;
      try {
        account = await this.rpc(
          () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
          options,
        );
      } catch (getAccountError) {
        // Surface a clear, actionable error when the account is not funded or
        // does not exist on the network, rather than leaking the raw RPC error.
        throw new AccountNotFundedError(publicKey, { cause: getAccountError });
      }
      const baseFee = BigInt(BASE_FEE) * BigInt(operations.length);
      const builder = new TransactionBuilder(account, {
        fee: baseFee.toString(),
        networkPassphrase: this.networkPassphrase,
      });
      for (const operation of operations) builder.addOperation(operation);
      const builtTx = builder.setTimeout(this.transactionTimeoutSeconds).build();

      // prepareTransaction simulates and assembles Soroban data for the whole transaction.
      options?.signal?.throwIfAborted();
      const prepared = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.prepareTransaction(builtTx)),
        options,
      );
      this.debugLogger.logSimulation(label, undefined, prepared.fee);

      const signedTxXdr = await this.wallet.signTransaction(prepared.toXDR(), {
        networkPassphrase: this.networkPassphrase,
      });
      const signedTx = TransactionBuilder.fromXDR(
        signedTxXdr,
        this.networkPassphrase,
      );
      if (!(signedTx instanceof Transaction)) {
        throw new SoroWillError(
          'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
        );
      }

      options?.signal?.throwIfAborted();
      // Failover only retries connection-level errors (see RpcEndpointPool). Re-sending the
      // same signed envelope is safe: it has the same hash and sequence number, so the
      // network applies it at most once and never double-executes the invocation.
      const sendResponse = await this.rpc(
        () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
        options,
      );
      this.debugLogger.logSubmission(label, undefined, sendResponse.hash);

      // Handle distinct sendTransaction statuses per the Soroban RPC spec.
      if (sendResponse.status === 'ERROR') {
        const errorXdr = sendResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
        throw new InvokeFailedError(label, `sendTransaction returned ERROR`, {
          status: sendResponse.status,
          errorXdr,
          diagnosticEventsXdr: (sendResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
          hash: sendResponse.hash,
        });
      }

      options?.signal?.throwIfAborted();
      if (sendResponse.status === 'TRY_AGAIN_LATER') {
        throw new SoroWillError(
          `SoroWill RPC node is under backpressure — transaction for ${label} could not be submitted. Retry later.`,
        );
      }

      if (sendResponse.status === 'DUPLICATE') {
        // The transaction was already submitted (or still in the mempool).
        // We can still poll for its final status using the returned hash.
        // Fall through to polling below.
      }

      // PENDING and DUPLICATE both proceed to polling.
      let txResponse: { createdAt: number; returnValue: xdr.ScVal | undefined };
      try {
        txResponse = await this.waitForTransaction(sendResponse.hash, options);
      } catch (pollError) {
        // If poll times out and auto fee-bump is enabled, retry with higher fee
        if (this.autoFeeBumpOnTimeout) {
          this.debugLogger.logPoll(label);

          const feeBumpFee = (await this.computeBumpedFee(baseFee, options)).toString();
          // Building the first transaction incremented `account`'s sequence number, so rebuild
          // from a fresh Account one below the pending transaction's sequence: the resubmission
          // then reuses that sequence and replaces the pending transaction instead of following it.
          const retrySource = new Account(publicKey, (BigInt(builtTx.sequence) - 1n).toString());
          const feeBumpBuilder = new TransactionBuilder(retrySource, {
            fee: feeBumpFee,
            networkPassphrase: this.networkPassphrase,
          });
          for (const operation of operations) feeBumpBuilder.addOperation(operation);
          const feeBumpTx = feeBumpBuilder.setTimeout(this.transactionTimeoutSeconds).build();

          const feeBumpPrepared = await this.rpc(
            () => this.rpcPool.withFailover((server) => server.prepareTransaction(feeBumpTx)),
            options,
          );

          const feeBumpSignedXdr = await this.wallet.signTransaction(feeBumpPrepared.toXDR(), {
            networkPassphrase: this.networkPassphrase,
          });
          const feeBumpSignedTx = TransactionBuilder.fromXDR(
            feeBumpSignedXdr,
            this.networkPassphrase,
          );
          if (!(feeBumpSignedTx instanceof Transaction)) {
            throw new SoroWillError(
              'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
            );
          }

          const feeBumpResponse = await this.rpc(
            () => this.rpcPool.withFailover((server) => server.sendTransaction(feeBumpSignedTx)),
            options,
          );

          if (feeBumpResponse.status === 'ERROR') {
            const errorXdr = feeBumpResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
            throw new InvokeFailedError(label, `fee-bump sendTransaction returned ERROR`, {
              status: feeBumpResponse.status,
              errorXdr,
              diagnosticEventsXdr: (feeBumpResponse as unknown as Record<string, unknown>).diagnosticEventsXdr ?? null,
              hash: feeBumpResponse.hash,
            });
          }

          this.debugLogger.logSubmission(label, undefined, feeBumpResponse.hash);

          txResponse = await this.waitForTransaction(feeBumpResponse.hash, options);
        } else {
          throw pollError;
        }
      }

      // Extract events from the transaction result meta, if available.
      // waitForTransaction returns the raw response; cast to access events.
      const rawResponse = txResponse as unknown as Record<string, unknown>;
      let events: Array<{ topics: string[]; data: unknown }> | undefined;
      if (Array.isArray(rawResponse.events)) {
        events = rawResponse.events as Array<{ topics: string[]; data: unknown }>;
      }

      return {
        txHash: sendResponse.hash,
        createdAt: txResponse.createdAt,
        returnValue: txResponse.returnValue,
        ...(events !== undefined ? { events } : {}),
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }
      throw mapContractError(error);
    }
  }

  /**
   * Builds an unsigned transaction for a contract invocation without simulating it.
   *
   * **IMPORTANT:** The returned transaction is **NOT prepared** (not simulated). It lacks the
   * footprint and resource fee estimates that Soroban simulation adds. Signing and submitting
   * this transaction directly will fail for any Soroban invocation that needs these estimates.
   *
   * To use this for a custom signing flow:
   * 1. Call this method to build the unsigned transaction XDR
   * 2. Convert to XDR with `.toXDR()` and pass to your signing mechanism
   * 3. After signing, call `prepareTransaction()` on the signed XDR to simulate and add fees
   * 4. Submit the prepared transaction with `submitSignedTransaction()`
   *
   * Alternatively, use the higher-level state-changing methods (e.g. `createWill()`) which
   * handle building, simulating, signing, and submitting atomically.
   *
   * @param method - The contract method name (e.g. `'create_will'`, `'check_in'`)
   * @param args - Arguments to the method as a record of name-value pairs
   * @param sourcePublicKey - Optional source account public key; defaults to the connected wallet
   * @returns An unsigned, unprepared transaction XDR
   * @throws {SimulationError} If the method name or arguments are invalid (during XDR encoding)
   * @throws {AccountNotFundedError} If the source account does not exist on the ledger
   * @throws {RequestTimeoutError} If the RPC request exceeds its configured timeout
   */
  async buildTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    return this.prepareInvocation(method, args, undefined, sourcePublicKey);
  }

  /**
   * Submits a signed transaction and waits for it to reach a terminal status.
   *
   * For custom signing flows using `buildTransaction()`, the transaction must be prepared
   * (simulated) BEFORE signing. The required workflow is:
   * 1. `buildTransaction()` to build an unsigned, unprepared transaction
   * 2. `prepareTransaction()` on the unsigned XDR to simulate and add fees
   * 3. Sign the prepared XDR with your signing mechanism
   * 4. Call this method with the signed XDR to submit and poll
   *
   * @param signedTxXdr - A signed, prepared transaction XDR string
   * @param options - Optional per-call timeout and abort signal
   * @returns An object with the transaction hash, ledger creation timestamp, and contract return value
   * @throws {SoroWillError} If the XDR is a fee-bump envelope or if the transaction does not succeed
   * @throws {SoroWillError} If RPC submission fails or the node is under backpressure
   * @throws {RequestTimeoutError} If polling exceeds its configured timeout
   */
  async submitSignedTransaction(
    signedTxXdr: string,
    options?: RequestOptions,
  ): Promise<{ txHash: string; createdAt: number; returnValue: ScVal | undefined }> {
    const signedTx = TransactionBuilder.fromXDR(signedTxXdr, this.networkPassphrase);
    if (!(signedTx instanceof Transaction)) {
      throw new SoroWillError(
        'Expected a plain Transaction envelope after signing, but received FeeBumpTransaction',
      );
    }
    const publicKey = await this.getWalletPublicKey();
    await this.rpc(
      () => this.rpcPool.withFailover((server) => server.getAccount(publicKey)),
      options,
    );
    // Safe to fail over: the identical signed envelope can only be applied once.
    const sendResponse = await this.rpc(
      () => this.rpcPool.withFailover((server) => server.sendTransaction(signedTx)),
      options,
    );

    if (sendResponse.status === 'ERROR') {
      const errorXdr = sendResponse.errorResult?.toXDR?.('base64') ?? 'no error result';
      throw new SoroWillError(`SoroWill transaction submission failed: ${errorXdr}`);
    }

    if (sendResponse.status === 'TRY_AGAIN_LATER') {
      throw new SoroWillError(
        `SoroWill RPC node is under backpressure — the transaction could not be submitted. Retry later.`,
      );
    }

    const txResponse = await this.rpc(
      () =>
        this.rpcPool.withFailover((server) =>
          server.pollTransaction(sendResponse.hash, { attempts: this.pollAttempts }),
        ),
      options,
    );

    if (txResponse.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
      throw new SoroWillError(`SoroWill transaction did not succeed: ${txResponse.status}`);
    }

    return {
      txHash: sendResponse.hash,
      createdAt: txResponse.createdAt,
      returnValue: txResponse.returnValue,
    };
  }

  /**
   * Builds a JSON-serializable error report (name, message, code, stack,
   * cause, SDK context) that users can attach to a support request.
   * Stack traces are always included here since the caller explicitly asks
   * for the report; routine logging only includes stacks when `debug` is on.
   */
  reportError(error: unknown): Record<string, unknown> {
    const err = error instanceof Error ? error : new Error(String(error));
    const cause = (err as { cause?: unknown }).cause;
    return {
      timestamp: new Date().toISOString(),
      name: err.name,
      message: err.message,
      code: (err as { code?: unknown }).code,
      stack: err.stack,
      cause: cause instanceof Error ? { name: cause.name, message: cause.message, stack: cause.stack } : cause,
      contractId: this.contract.contractId(),
      networkPassphrase: this.networkPassphrase,
    };
  }

  async refreshSpec(options?: RequestOptions): Promise<InstanceType<typeof Spec>> {
    this.specPromise = undefined;
    return this.getSpec(options);
  }

  /**
   * Returns network-wide inclusion-fee statistics (`rpc.Api.GetFeeStatsResponse`).
   *
   * **Note:** these stats cover only the *inclusion* fee. Soroban invocations
   * also pay a resource fee (CPU instructions, memory, ledger reads/writes,
   * storage rent) that depends on the specific operation — e.g. `merge_wills`
   * with many beneficiaries costs far more than `check_in`. Do not size a
   * transaction fee from these stats alone; use {@link previewFee} to simulate
   * the actual cost. State-changing SDK calls always simulate via
   * `prepareTransaction` before submission, so the submitted fee already
   * includes the simulated resource fee.
   *
   * @see https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
   *
   * @throws {SoroWillError} If the configured RPC server does not support `getFeeStats`.
   */
  async getNetworkFeeStats(options?: RequestOptions): Promise<rpc.Api.GetFeeStatsResponse> {
    const server = this.server;
    if (typeof server.getFeeStats !== 'function') {
      throw new SoroWillError('The configured RPC server does not support getFeeStats');
    }
    return this.rpc(() => server.getFeeStats!(), options);
  }

  /**
   * Verifies the wallet is on the expected network before signing.
   *
   * - Wallets that do not implement `getNetwork` are not checked (explicit opt-out).
   * - If `getNetwork` rejects, a {@link SoroWillError} is thrown with the original error as `cause`.
   * - An empty or missing passphrase cannot be verified and is treated as a mismatch
   *   ({@link WalletNetworkMismatchError} with an empty `actualNetworkPassphrase`).
   */
  /**
   * Inclusion fee for a replacement transaction: the network's p90 Soroban inclusion
   * fee (from fee stats) per operation, but never below the 10x multiplier stellar-core
   * requires to replace a pending transaction with the same sequence number.
   */
  private async computeBumpedFee(originalFee: bigint, options?: RequestOptions): Promise<bigint> {
    const minimum = originalFee * 10n;
    try {
      const stats = await this.getNetworkFeeStats(options);
      const p90 = BigInt(stats.sorobanInclusionFee.p90);
      const fromStats = p90 * BigInt(originalFee / BigInt(BASE_FEE) || 1n);
      return fromStats > minimum ? fromStats : minimum;
    } catch {
      return minimum;
    }
  }

  async assertWalletNetwork(network: { networkPassphrase: string }): Promise<void> {
    if (!this.wallet.getNetwork) {
      return;
    }

    let details: { networkPassphrase?: string };
    try {
      details = await this.wallet.getNetwork();
    } catch (error) {
      throw new SoroWillError('Failed to read the wallet network; refusing to sign', { cause: error });
    }
    const actual = details?.networkPassphrase ?? '';
    if (actual !== network.networkPassphrase) {
      throw new WalletNetworkMismatchError(network.networkPassphrase, actual);
    }
  }

  // -----------------------------------------------------------------------
  // Private: RPC wrapper through queue
  // -----------------------------------------------------------------------

  /** Sends every RPC through the shared FIFO queue with the selected timeout. */
  private rpc<T>(request: () => Promise<T>, options?: RequestOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    return this.queue.enqueue(request, options?.timeoutMs ?? this.timeoutMs, options?.signal);
  }

  /**
   * Retries `operation` up to `this.retryOptions.maxAttempts` times with
   * exponential backoff, for transient read-path failures. Defaults to a
   * single attempt (no retry) unless the caller opts in via
   * `SoroWillClientOptions.retry`.
   *
   * Typed errors ({@link RequestTimeoutError}, `AbortError`) and failures of a
   * single-attempt call propagate unchanged; only a failure that exhausted
   * more than one attempt is wrapped in a `SoroWillError` (original in `cause`).
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    const { maxAttempts, initialDelayMs, maxDelayMs, backoffFactor } = this.retryOptions;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (
          error instanceof RequestTimeoutError ||
          (error instanceof Error && error.name === 'AbortError') ||
          maxAttempts === 1
        ) {
          throw error;
        }
        lastError = error;
        if (attempt === maxAttempts) {
          break;
        }
        const delay = Math.min(initialDelayMs * backoffFactor ** (attempt - 1), maxDelayMs);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw new SoroWillError(
      `SoroWill RPC call failed after ${maxAttempts} attempt${maxAttempts === 1 ? '' : 's'}: ` +
        (lastError instanceof Error ? lastError.message : String(lastError)),
      { cause: lastError },
    );
  }

  // -----------------------------------------------------------------------
  // Private: transaction building helpers
  // -----------------------------------------------------------------------

  private async buildInvocationTransaction(
    method: string,
    args: Record<string, unknown>,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const spec = await this.getSpec();
    const scArgs = spec.funcArgsToScVals(method, args);
    const operation = this.contract.call(method, ...scArgs);

    const publicKey = sourcePublicKey ?? (await this.getWalletPublicKey());
    const account = await this.rpcPool.withFailover((server) => server.getAccount(publicKey));
    return this.buildInvocationEnvelope([operation], account);
  }

  private buildInvocationEnvelope(
    operations: readonly xdr.Operation[],
    account: Account,
  ): Transaction {
    const builder = new TransactionBuilder(account, {
      fee: (BigInt(BASE_FEE) * BigInt(operations.length)).toString(),
      networkPassphrase: this.networkPassphrase,
    });

    for (const operation of operations) {
      builder.addOperation(operation);
    }

    return builder.setTimeout(this.transactionTimeoutSeconds).build();
  }

  private async prepareInvocation(
    method: string,
    args: Record<string, unknown>,
    builtTx?: Transaction,
    sourcePublicKey?: string,
  ): Promise<Transaction> {
    const transaction =
      builtTx ?? (await this.buildInvocationTransaction(method, args, sourcePublicKey));
    return this.rpcPool.withFailover((server) => server.prepareTransaction(transaction));
  }

  private async getWalletPublicKey(): Promise<string> {
    return this.wallet.getPublicKey();
  }
}
