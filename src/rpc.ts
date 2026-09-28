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
 * Milliseconds to wait after a failover before opportunistically retrying
 * the originally preferred (first-listed) RPC endpoint again. Without this,
 * a single transient blip on the primary endpoint would pin the pool to
 * whichever backup it failed over to for the rest of the process's lifetime.
 */
const DEFAULT_FAILOVER_COOLDOWN_MS = 60_000;

/**
 * Default per-endpoint timeout in milliseconds (issue #485).
 *
 * If an endpoint does not respond within this window the pool treats it as a
 * transient failure, rotates it to the back, and retries the next endpoint.
 * 30 seconds is a conservative but practical ceiling for a Soroban RPC call.
 */
const DEFAULT_ENDPOINT_TIMEOUT_MS = 30_000;

/**
 * Races `promise` against a timeout.
 *
 * If `timeoutMs` is not a positive finite number the original promise is
 * returned unchanged so existing callers that pass `0` or `Infinity` are
 * unaffected.
 */
function withEndpointTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`RPC endpoint timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class RpcEndpointPool {
  private readonly servers: SoroWillRpcServer[];
  private readonly rpcUrls: string[];
  private readonly failoverCooldownMs: number;
  /** Per-endpoint response timeout in milliseconds (issue #485). */
  private readonly endpointTimeoutMs: number;
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
   * @param endpointTimeoutMs - Maximum time to wait for a single endpoint
   * before treating it as unresponsive and rotating to the next one.
   * Defaults to {@link DEFAULT_ENDPOINT_TIMEOUT_MS}. Pass `0` or `Infinity`
   * to disable the per-endpoint timeout entirely.
   */
  constructor(
    rpcUrls: readonly string[],
    serverOverride?: SoroWillRpcServer,
    failoverCooldownMs: number = DEFAULT_FAILOVER_COOLDOWN_MS,
    endpointTimeoutMs: number = DEFAULT_ENDPOINT_TIMEOUT_MS,
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
    this.endpointTimeoutMs = endpointTimeoutMs;
    this.servers = serverOverride
      ? uniqueRpcUrls.map(() => serverOverride)
      : uniqueRpcUrls.map(
          (rpcUrl) => new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith('http://') }),
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

  async withFailover<T>(operation: (server: SoroWillRpcServer, rpcUrl: string) => Promise<T>): Promise<T> {
    this.maybeRepromotePrimaryEndpoint();
    let lastError: unknown;

    for (let attempt = 0; attempt < this.servers.length; attempt += 1) {
      const rpcUrl = this.rpcUrls[this.activeIndex];
      const server = this.servers[this.activeIndex];

      if (!rpcUrl || !server) {
        break;
      }

      try {
        // Enforce a per-endpoint timeout so a hanging primary endpoint does
        // not block the pool forever — it is rotated to the back of the pool
        // and the next endpoint is tried instead (issue #485).
        return await withEndpointTimeout(operation(server, rpcUrl), this.endpointTimeoutMs);
      } catch (error) {
        lastError = error;
        if (!isRetryableRpcConnectionError(error) || attempt === this.servers.length - 1) {
          throw error;
        }
        this.lastFailoverAt = Date.now();
        this.activeIndex = (this.activeIndex + 1) % this.servers.length;
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
}
