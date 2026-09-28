import { rpc } from '@stellar/stellar-sdk';
import type { SoroWillRpcServer } from './SoroWillClient';

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
    const response = await server.getTransaction(transactionHash);
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
  private readonly servers: SoroWillRpcServer[];
  private readonly rpcUrls: string[];
  private readonly failoverCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly timeoutMaxAttempts: number;
  private readonly timeoutRetryBaseDelayMs: number;
  private activeIndex = 0;
  private lastFailoverAt: number | null = null;

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
   */
  constructor(
    rpcUrls: readonly string[],
    serverOverride?: SoroWillRpcServer,
    failoverCooldownMs: number = DEFAULT_FAILOVER_COOLDOWN_MS,
    timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
    timeoutMaxAttempts: number = DEFAULT_RPC_TIMEOUT_MAX_ATTEMPTS,
    timeoutRetryBaseDelayMs: number = DEFAULT_RPC_TIMEOUT_RETRY_BASE_DELAY_MS,
  ) {
    const normalizedRpcUrls = rpcUrls
      .map((rpcUrl) => rpcUrl.trim())
      .filter((rpcUrl) => rpcUrl.length > 0);

    if (normalizedRpcUrls.length === 0) {
      throw new Error('At least one RPC URL must be configured');
    }

    for (const rpcUrl of normalizedRpcUrls) {
      const parsed = new URL(rpcUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`Invalid RPC URL: ${rpcUrl}`);
      }
    }

    const uniqueRpcUrls = Array.from(new Set(normalizedRpcUrls));

    this.rpcUrls = uniqueRpcUrls;
    this.failoverCooldownMs = failoverCooldownMs;
    this.timeoutMs = timeoutMs;
    this.timeoutMaxAttempts = Math.max(1, timeoutMaxAttempts);
    this.timeoutRetryBaseDelayMs = timeoutRetryBaseDelayMs;
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
        return await operation(server, rpcUrl);
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

  async withFailover<T>(operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>): Promise<T> {
    this.maybeRepromotePrimaryEndpoint();
    let lastError: unknown;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      const index = this.activeIndex;
      const rpcUrl = this.rpcUrls[index];
      const server = this.servers[index];

      if (!rpcUrl || !server) {
        break;
      }

      try {
        return await this.runWithTimeoutRetry(operation, server, rpcUrl);
      } catch (error) {
        lastError = error;
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
