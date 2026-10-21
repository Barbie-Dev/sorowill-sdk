import { rpc } from '@stellar/stellar-sdk';
import type { SoroWillRpcServer } from './SoroWillClient';

export const DEFAULT_RPC_TIMEOUT_MS = 30_000;
export const DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS = 3;
export const DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS = 1_000;

/**
 * Base delay applied to an RPC endpoint after it fails a request. The delay
 * doubles for every consecutive failure (exponential backoff) and is capped at
 * {@link DEFAULT_RPC_ENDPOINT_BACKOFF_MAX_MS}. While an endpoint is backing
 * off it is deprioritized — the pool routes requests to other healthy
 * endpoints instead of immediately retrying the failing one.
 */
export const DEFAULT_RPC_ENDPOINT_BACKOFF_BASE_MS = 1_000;

/** Upper bound for the per-endpoint exponential backoff delay. */
export const DEFAULT_RPC_ENDPOINT_BACKOFF_MAX_MS = 30_000;

/**
 * Validates an RPC endpoint URL at the moment it enters an
 * {@link RpcEndpointPool} (construction or {@link RpcEndpointPool.add}), so
 * that malformed URLs are rejected immediately instead of surfacing as
 * confusing network errors on the first request.
 *
 * Accepted formats: absolute `http://` or `https://` URLs with a hostname,
 * e.g. `https://soroban-testnet.stellar.org`.
 */
function assertValidRpcUrl(rpcUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch (cause) {
    throw new Error(
      `Invalid RPC URL: "${rpcUrl}" — must be an absolute http(s) URL, ` +
        `e.g. "https://soroban-testnet.stellar.org"`,
      { cause },
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Invalid RPC URL: "${rpcUrl}" — only http(s) endpoints are supported ` +
        `(got protocol "${parsed.protocol}")`,
    );
  }

  if (parsed.hostname.length === 0) {
    throw new Error(`Invalid RPC URL: "${rpcUrl}" — URL must include a hostname`);
  }

  return parsed;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wraps a promise with a timeout; rejects if the promise doesn't settle within ms. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }

  const TIMEOUT_SYMBOL = Symbol('timeout');
  return Promise.race<T | typeof TIMEOUT_SYMBOL>([
    promise,
    new Promise<typeof TIMEOUT_SYMBOL>((resolve) => {
      setTimeout(() => resolve(TIMEOUT_SYMBOL), ms);
    }),
  ]).then((result) => {
    if (result === TIMEOUT_SYMBOL) {
      throw new Error(`Request timed out, timeout exceeded ${ms}ms`);
    }
    return result as T;
  });
}

export function isRetryableRpcConnectionError(error: unknown): boolean {
  const CONNECTION_FRAGMENTS = [
    'fetch failed',
    'network error',
    'failed to fetch',
    'econnrefused',
    'etimedout',
    'timeout',
    'socket hang up',
    'enotfound',
    'econnreset',
    'too many requests',
    'rate limit',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
  ];

  // HTTP status codes for rate-limiting and server overload (429, 502, 503,
  // 504) — matched as whole numbers so they don't fire on unrelated digits
  // embedded in a larger number.
  const RETRYABLE_STATUS_CODE = /\b(429|502|503|504)\b/;

  // "connect" as a verb ("could not connect", "failed to connect") is a real
  // connection failure, but the same substring also appears in unrelated
  // application-level wallet state ("wallet not connected", "signer
  // disconnected") — exclude those via the "disconnect"/"connected" forms.
  const CONNECT_VERB = /(?<!dis)connect(?!ed)/i;

  const matches = (text: string): boolean => {
    const lower = text.toLowerCase();
    return (
      CONNECTION_FRAGMENTS.some((fragment) => lower.includes(fragment)) ||
      RETRYABLE_STATUS_CODE.test(text) ||
      CONNECT_VERB.test(text)
    );
  };

  if (error instanceof Error) {
    return matches(error.message);
  }

  // Plain strings (some runtimes throw strings directly)
  if (typeof error === 'string') {
    return matches(error);
  }

  // DOMException and DOMException-like objects ({ name, message })
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj['message'] === 'string' && matches(obj['message'])) {
      return true;
    }
    if (typeof obj['name'] === 'string' && matches(obj['name'])) {
      return true;
    }
  }

  return false;
}

/**
 * Detects whether an error is specifically a timeout (as opposed to a generic
 * connection failure). Timeout errors are retried with exponential backoff
 * because a slow-but-healthy RPC endpoint may simply need more time, whereas
 * other connection errors are handled by endpoint failover.
 */
export function isRpcTimeoutError(error: unknown): boolean {
  const TIMEOUT_FRAGMENTS = ['timeout', 'timed out', 'etimedout', 'deadline exceeded'];

  const matches = (text: string): boolean => {
    const lower = text.toLowerCase();
    return TIMEOUT_FRAGMENTS.some((fragment) => lower.includes(fragment));
  };

  if (error instanceof Error) {
    return matches(error.message) || matches(error.name);
  }

  if (typeof error === 'string') {
    return matches(error);
  }

  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (typeof obj['message'] === 'string' && matches(obj['message'])) {
      return true;
    }
    if (typeof obj['name'] === 'string' && matches(obj['name'])) {
      return true;
    }
  }

  return false;
}

/**
 * Milliseconds to wait after a failover before opportunistically retrying
 * the originally preferred (first-listed) RPC endpoint again. Without this,
 * a single transient blip on the primary endpoint would pin the pool to
 * whichever backup it failed over to for the rest of the process's lifetime.
 */
const DEFAULT_FAILOVER_COOLDOWN_MS = 60_000;

/**
 * Default number of consecutive failures before an endpoint is quarantined
 * by the circuit breaker.
 */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Default cooldown (ms) before a quarantined endpoint is eligible to be
 * retried again.
 */
export const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

/**
 * Per-endpoint circuit-breaker state.
 */
interface EndpointCircuitState {
  /** Number of consecutive failures recorded for this endpoint. */
  failureCount: number;
  /** Timestamp (ms) when the endpoint was quarantined, or null if not quarantined. */
  quarantinedAt: number | null;
}

/**
 * Options for configuring the circuit breaker behaviour of
 * {@link RpcEndpointPool}.
 */
export interface CircuitBreakerOptions {
  /**
   * Maximum consecutive failures before an endpoint is quarantined.
   * Defaults to {@link DEFAULT_CIRCUIT_BREAKER_THRESHOLD}.
   */
  threshold?: number;
  /**
   * Cooldown in milliseconds before a quarantined endpoint is eligible to
   * be retried. Defaults to {@link DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS}.
   */
  cooldownMs?: number;
}

/**
 * Terminal transaction statuses reported by `getTransaction`. A transaction
 * in any of these states has already been resolved on-chain, so a fee-bump
 * must NOT be submitted for it (doing so risks a duplicate operation).
 */
const TERMINAL_TRANSACTION_STATUSES = new Set(['SUCCESS', 'FAILED']);

/**
 * Queries the network for the current status of a submitted transaction.
 *
 * Returns `true` when the transaction has reached a terminal state
 * (`SUCCESS` or `FAILED`) and therefore must not be fee-bumped, and `false`
 * when it is still pending (e.g. `NOT_FOUND`) or its status cannot be
 * determined. Callers that gate a fee-bump on this result should treat an
 * indeterminate status as "still pending" so a genuinely stuck transaction
 * is not left unbumped.
 */
export async function isTransactionResolved(
  server: SoroWillRpcServer,
  transactionHash: string,
): Promise<boolean> {
  try {
    const response = await server.pollTransaction(transactionHash, { attempts: 1 });
    const status = (response as { status?: unknown }).status;
    return typeof status === 'string' && TERMINAL_TRANSACTION_STATUSES.has(status);
  } catch {
    // A lookup failure (e.g. the transaction is not yet indexed) means we
    // cannot confirm resolution, so report it as unresolved and allow the
    // caller to proceed with the bump.
    return false;
  }
}

export class RpcEndpointPool {
  private readonly servers: SoroWillRpcServer[] = [];
  private readonly rpcUrls: string[] = [];
  private readonly serverOverride: SoroWillRpcServer | undefined;
  private readonly failoverCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly timeoutMaxAttempts: number;
  private readonly timeoutRetryBaseDelayMs: number;
  private readonly circuitBreakerThreshold: number;
  private readonly circuitBreakerCooldownMs: number;
  private activeIndex = 0;
  private lastFailoverAt: number | null = null;
  private readonly circuitStates: EndpointCircuitState[];

  /**
   * @param serverOverride - When provided (e.g. `SoroWillClientOptions.rpcServer`
   * in tests), every endpoint in the pool uses this server instead of
   * constructing a real `rpc.Server` per URL. Without this, `withFailover`
   * would silently bypass an injected test double and hit the real network.
   * @param failoverCooldownMs - How long to keep using a backup endpoint
   * after a failover before opportunistically retrying the primary
   * (first-listed) endpoint again. Defaults to {@link DEFAULT_FAILOVER_COOLDOWN_MS}.
   * @param timeoutMs - Per-request RPC timeout in milliseconds. Defaults to
   * {@link DEFAULT_RPC_TIMEOUT_MS} (30s).
   * @param timeoutMaxAttempts - Maximum attempts (initial try + retries) for
   * timeout errors. Defaults to {@link DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS}.
   * @param timeoutRetryBaseDelayMs - Base delay for exponential backoff on
   * timeout errors. Defaults to {@link DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS}.
   * @param circuitBreaker - Optional circuit breaker configuration. When
   * provided, endpoints that exceed the failure threshold are quarantined
   * and skipped during failover until the cooldown elapses.
   */
  constructor(
    rpcUrls: readonly string[],
    serverOverride?: SoroWillRpcServer,
    failoverCooldownMs: number = DEFAULT_FAILOVER_COOLDOWN_MS,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    timeoutMaxAttempts: number = DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS,
    timeoutRetryBaseDelayMs: number = DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS,
    circuitBreaker?: CircuitBreakerOptions,
  ) {
    const normalizedRpcUrls = rpcUrls
      .map((rpcUrl) => rpcUrl.trim())
      .filter((rpcUrl) => rpcUrl.length > 0);

    if (normalizedRpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be configured');
    }

    // Reject malformed or non-http(s) URLs immediately rather than letting
    // them surface later as confusing network errors on the first request.
    for (const rpcUrl of normalizedRpcUrls) {
      assertValidRpcUrl(rpcUrl);
    }

    const uniqueRpcUrls = Array.from(new Set(normalizedRpcUrls));

    this.rpcUrls.push(...uniqueRpcUrls);
    this.serverOverride = serverOverride;
    this.failoverCooldownMs = failoverCooldownMs;
    this.timeoutMs = timeoutMs;
    this.timeoutMaxAttempts = Math.max(1, timeoutMaxAttempts);
    this.timeoutRetryBaseDelayMs = timeoutRetryBaseDelayMs;
    this.circuitBreakerThreshold = circuitBreaker?.threshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.circuitBreakerCooldownMs = circuitBreaker?.cooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.circuitStates = uniqueRpcUrls.map(() => ({
      failureCount: 0,
      quarantinedAt: null,
    }));
    this.servers = serverOverride
      ? uniqueRpcUrls.map(() => serverOverride)
      : uniqueRpcUrls.map(
          (rpcUrl) =>
            new rpc.Server(rpcUrl, {
              allowHttp: rpcUrl.startsWith('http://'),
              timeout: timeoutMs,
            }),
        );
  }

  /**
   * Re-promotes the primary (first-listed) endpoint once the cooldown since
   * the last failover has elapsed, giving it a chance to be retried after a
   * transient outage recovers instead of being abandoned permanently.
   */
  private maybeRepromotePrimaryEndpoint(): void {
    if (
      this.activeIndex !== 0 &&
      this.lastFailoverAt !== null &&
      Date.now() - this.lastFailoverAt >= this.failoverCooldownMs
    ) {
      this.activeIndex = 0;
      this.lastFailoverAt = null;
    }
  }

  /** Whether an endpoint is still inside its backoff window. */
  private isEndpointUnderBackoff(index: number): boolean {
    return Date.now() < (this.backoffUntil[index] ?? 0);
  }

  /**
   * Records a retryable failure for an endpoint and schedules its
   * exponential backoff: `base * 2^(consecutiveFailures - 1)`, capped at
   * `endpointBackoffMaxMs`.
   */
  private recordEndpointFailure(index: number): void {
    const failures = (this.consecutiveFailures[index] ?? 0) + 1;
    this.consecutiveFailures[index] = failures;
    const exponentialDelay = this.endpointBackoffBaseMs * 2 ** (failures - 1);
    this.backoffUntil[index] = Date.now() + Math.min(exponentialDelay, this.endpointBackoffMaxMs);
  }

  /** Clears the backoff state of an endpoint after a successful request. */
  private recordEndpointSuccess(index: number): void {
    this.consecutiveFailures[index] = 0;
    this.backoffUntil[index] = 0;
  }

  /**
   * Picks the endpoint a request should be routed to: the active endpoint if
   * it is not backing off, otherwise the next endpoint (in rotation order)
   * that is not backing off. If every endpoint is backing off, the active
   * endpoint is used anyway — retrying the least-bad option beats failing
   * outright, and the request would otherwise never be able to recover.
   */
  private selectEndpointIndex(): number {
    if (!this.isEndpointUnderBackoff(this.activeIndex)) {
      return this.activeIndex;
    }

    for (let offset = 1; offset < this.servers.length; offset += 1) {
      const index = (this.activeIndex + offset) % this.servers.length;
      if (!this.isEndpointUnderBackoff(index)) {
        return index;
      }
    }

    return this.activeIndex;
  }

  /**
   * Runs `operation` against the active endpoint, retrying timeout errors with
   * exponential backoff before falling back to the next endpoint. Non-timeout
   * connection errors skip straight to failover.
   */
  private async runWithTimeoutRetry<T>(
    operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>,
    server: SoroWillRpcServer,
    rpcUrl: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt < this.timeoutMaxAttempts; attempt += 1) {
      try {
        // Enforce per-endpoint timeout
        return await withTimeout(operation(server, rpcUrl), this.timeoutMs);
      } catch (error) {
        lastError = error;
        const isLastAttempt = attempt === this.timeoutMaxAttempts - 1;
        if (!isRpcTimeoutError(error) || isLastAttempt) {
          throw error;
        }
        await sleep(this.timeoutRetryBaseDelayMs * 2 ** attempt);
      }
    }

    throw lastError ?? new Error('RPC timeout retries exhausted');
  }

  /**
   * Returns `true` when the endpoint at `index` is currently quarantined by
   * the circuit breaker (i.e. it has exceeded the failure threshold and the
   * cooldown has not yet elapsed).
   */
  private isEndpointQuarantined(index: number): boolean {
    const state = this.circuitStates[index];
    if (state?.quarantinedAt === null) {
      return false;
    }
    if (state !== undefined && Date.now() - state.quarantinedAt >= this.circuitBreakerCooldownMs) {
      // Cooldown elapsed — allow re-entry by clearing quarantine state.
      state.quarantinedAt = null;
      state.failureCount = 0;
      return false;
    }
    return true;
  }

  /**
   * Records a failure for the endpoint at `index`. When the consecutive
   * failure count reaches the circuit breaker threshold, the endpoint is
   * quarantined.
   */
  private recordEndpointFailure(index: number): void {
    const state = this.circuitStates[index];
    if (state === undefined) {
      return;
    }
    state.failureCount += 1;
    if (state.failureCount >= this.circuitBreakerThreshold && state.quarantinedAt === null) {
      state.quarantinedAt = Date.now();
    }
  }

  /**
   * Resets the circuit-breaker state for the endpoint at `index` after a
   * successful call.
   */
  private resetEndpointFailure(index: number): void {
    const state = this.circuitStates[index];
    if (state === undefined) {
      return;
    }
    state.failureCount = 0;
    state.quarantinedAt = null;
  }

  async withFailover<T>(operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>): Promise<T> {
    this.maybeRepromotePrimaryEndpoint();
    let lastError: unknown;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      // Route around endpoints that are still backing off from a previous
      // failure instead of immediately retrying them.
      const index = this.selectEndpointIndex();
      const rpcUrl = this.rpcUrls[index];
      const server = this.servers[index];

      if (!rpcUrl || !server) {
        break;
      }

      // Skip endpoints quarantined by the circuit breaker.
      if (this.isEndpointQuarantined(index)) {
        // Advance past the quarantined endpoint without consuming a real
        // attempt, so the loop can try the next available endpoint.
        if (this.activeIndex === index) {
          this.activeIndex = (index + 1) % this.servers.length;
        }
        continue;
      }

      try {
        const result = await this.runWithTimeoutRetry(operation, server, rpcUrl);
        // Success — reset the circuit breaker for this endpoint.
        this.resetEndpointFailure(index);
        return result;
      } catch (error) {
        lastError = error;
        this.recordEndpointFailure(index);
        if (!isRetryableRpcConnectionError(error) || attempt === this.servers.length - 1) {
          throw error;
        }
        // Only advance if no concurrent call has already failed over away from this endpoint.
        if (this.activeIndex === index) {
          this.lastFailoverAt = Date.now();
          this.activeIndex = (index + 1) % this.servers.length;
        }
      }
    }

    throw lastError ?? new Error('RPC failover exhausted every configured endpoint');
  }

  getActiveRpcUrl(): string {
    const rpcUrl = this.rpcUrls[this.activeIndex];
    if (!rpcUrl) {
      throw new Error('No active RPC URL is configured');
    }
    return rpcUrl;
  }

  /**
   * Returns the RPC server bound to the pool's *current* active endpoint.
   *
   * Callers that cache a server reference (e.g. `getNetworkFeeStats` on a
   * fresh client instance) would otherwise keep talking to whichever
   * endpoint was active when the reference was captured, detaching from the
   * client's current network context after a network switch or failover.
   * Resolving the server lazily through this accessor keeps fee queries
   * pinned to the live network context.
   */
  getActiveServer(): SoroWillRpcServer {
    this.maybeRepromotePrimaryEndpoint();
    const server = this.servers[this.activeIndex];
    if (!server) {
      throw new Error('No active RPC server is configured');
    }
    return server;
  }
}
