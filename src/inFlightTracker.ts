import { DuplicateOperationError } from './errors';

type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
  /** Wall-clock ms when this entry was added. Used for TTL eviction (issue #487). */
  createdAt: number;
}

interface FailedOperation {
  sequence: string;
  failedAt: number;
}

const FAILED_SEQUENCE_TTL_MS = 60_000;
const DEFAULT_MAX_IN_FLIGHT = 100;
const DEFAULT_TTL_MS = 120_000;

/**
 * Shared, process-wide tracker used to deduplicate identical concurrent
 * requests across every SoroWillClient instance (multiple tabs, workers, etc.).
 *
 * A per-client tracker only deduplicates calls made through the same client
 * instance. When two clients issue the same request concurrently they each
 * hold their own tracker and both hit the network. Passing this singleton to
 * `new SoroWillClient({ inFlightTracker: globalInFlightTracker })` (or simply
 * reusing a single SoroWillClient instance) makes the deduplication global.
 */

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();
  private readonly failedSequences = new Map<OperationKey, FailedOperation>();
  private readonly maxInFlight: number;
  private readonly ttlMs: number;
  private readonly scopeId: string | undefined;

  constructor(scopeIdOrMaxInFlight?: string | number, ttlMs: number = DEFAULT_TTL_MS) {
    if (typeof scopeIdOrMaxInFlight === 'string') {
      // Called with scopeId
      this.scopeId = scopeIdOrMaxInFlight;
      this.maxInFlight = DEFAULT_MAX_IN_FLIGHT;
      this.ttlMs = ttlMs;
    } else {
      // Called with maxInFlight (backwards compatible)
      this.scopeId = undefined;
      this.maxInFlight = scopeIdOrMaxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
      this.ttlMs = ttlMs;
    }
  }

  getKey(willId: string | bigint, method: string, clientId?: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    const scope = clientId ?? this.scopeId;
    return scope ? `${scope}::${id}:${method}` : `${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string, clientId?: string): boolean {
    const key = this.getKey(willId, method, clientId);
    const op = this.inFlight.get(key);
    if (!op) return false;

    // Lazy eviction: check if this entry has expired
    if (this.isExpired(op)) {
      this.evict(key, op);
      return false;
    }

    return true;
  }

  getInFlightPromise<T>(
    willId: string | bigint,
    method: string,
    clientId?: string,
  ): OperationResult<T> | undefined {
    const key = this.getKey(willId, method, clientId);
    const op = this.inFlight.get(key);
    if (!op) return undefined;

    // Lazy eviction: check if this entry has expired
    if (this.isExpired(op)) {
      this.evict(key, op);
      return undefined;
    }

    return op.promise as OperationResult<T>;
  }

  /**
   * Records that a feeBump operation failed while holding the given sequence
   * number. A subsequent retry that reuses the same sequence number must not
   * be treated as a fresh in-flight operation, otherwise the retry can race
   * with the still-pending failed transaction and reuse an in-use sequence.
   */
  markFailed(
    willId: string | bigint,
    method: string,
    sequence: string | bigint,
    clientId?: string,
  ): void {
    const key = this.getKey(willId, method, clientId);
    this.failedSequences.set(key, {
      sequence: typeof sequence === 'bigint' ? sequence.toString() : sequence,
      failedAt: Date.now(),
    });
  }

  /**
   * Returns true when the given sequence number was previously used by a
   * failed operation for this key and has not yet been superseded. Callers
   * should advance the sequence number before retrying instead of reusing it.
   */
  isSequenceReused(
    willId: string | bigint,
    method: string,
    sequence: string | bigint,
    clientId?: string,
  ): boolean {
    const key = this.getKey(willId, method, clientId);
    const failed = this.failedSequences.get(key);
    if (!failed) {
      return false;
    }
    if (Date.now() - failed.failedAt > FAILED_SEQUENCE_TTL_MS) {
      this.failedSequences.delete(key);
      return false;
    }
    const seq = typeof sequence === 'bigint' ? sequence.toString() : sequence;
    return failed.sequence === seq;
  }

  /**
   * Clears the failed-sequence record for a key once a retry has advanced
   * past the previously failed sequence number.
   */
  clearFailed(willId: string | bigint, method: string, clientId?: string): void {
    this.failedSequences.delete(this.getKey(willId, method, clientId));
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
    clientId?: string,
  ): Promise<T> {
    const key = this.getKey(willId, method, clientId);

    const existing = this.inFlight.get(key);
    if (existing) {
      if (!this.isExpired(existing)) {
        return existing.promise as Promise<T>;
      }
      // Expired entry — evict and start a fresh operation.
      this.evict(key, existing);
    }

    // Prune expired entries and enforce the size cap before adding a new one.
    this.pruneExpired();
    if (this.inFlight.size >= this.maxInFlight) {
      this.evictOldest();
    }

    const controller = new AbortController();
    const entry = { controller, createdAt: Date.now() } as InFlightOperation<T>;
    entry.promise = Promise.resolve(operation(controller.signal)).finally(() => {
      // Only remove the entry this call created; a newer track() may own the key now.
      if (this.inFlight.get(key) === entry) {
        this.inFlight.delete(key);
      }
    });

    this.inFlight.set(key, entry as InFlightOperation<unknown>);
    return entry.promise;
  }

  /**
   * Like {@link track}, but rejects the duplicate instead of coalescing it
   * onto the in-flight promise.
   *
   * When an unexpired operation is already in flight for the same
   * (willId, method) pair, the returned promise rejects with a
   * {@link DuplicateOperationError} and `operation` is never invoked. This
   * guarantees that at most one transaction per (willId, method) can be
   * submitted at a time, even across concurrent callers (#523).
   *
   * Expired entries are lazily evicted first, so a stale entry (e.g. an
   * operation that never settled) cannot block retries forever.
   *
   * @throws {DuplicateOperationError} via the returned (rejected) promise when
   *   an identical operation is already in flight.
   */
  trackExclusive<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
    clientId?: string,
  ): Promise<T> {
    const key = this.getKey(willId, method, clientId);

    const existing = this.inFlight.get(key);
    if (existing) {
      if (!this.isExpired(existing)) {
        return Promise.reject(new DuplicateOperationError(willId, method));
      }
      // Expired entry — evict and start a fresh operation.
      this.evict(key, existing);
    }

    return this.track(willId, method, operation, clientId);
  }

  /**
   * Runs `operation` only if no operation is currently in flight for the given
   * will/method pair. Unlike {@link track}, this is intended for timeout-driven
   * follow-up work (e.g. auto fee-bump) where the caller must first confirm the
   * original operation is still pending before acting. If the original operation
   * has already settled (success or failure), the in-flight entry is gone and the
   * guard prevents a duplicate submission.
   */
  trackIfPending<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): Promise<T> | undefined {
    const key = this.getKey(willId, method);

    if (!this.inFlight.has(key)) {
      return undefined;
    }

    return this.track(willId, method, operation);
  }

  clear(): void {
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
    this.failedSequences.clear();
  }

  abort(willId: string | bigint, method: string, clientId?: string): void {
    const key = this.getKey(willId, method, clientId);
    const op = this.inFlight.get(key);
    if (op) {
      op.controller.abort();
      this.inFlight.delete(key);
    }
  }

  /**
   * Returns the current number of tracked in-flight operations.
   * Useful for monitoring and testing.
   */
  get size(): number {
    return this.inFlight.size;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private isExpired(op: InFlightOperation<unknown>): boolean {
    return Date.now() - op.createdAt > this.ttlMs;
  }

  private evict(key: OperationKey, op: InFlightOperation<unknown>): void {
    op.controller.abort();
    this.inFlight.delete(key);
  }

  /** Removes all entries whose TTL has elapsed. */
  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, op] of this.inFlight) {
      if (now - op.createdAt > this.ttlMs) {
        op.controller.abort();
        this.inFlight.delete(key);
      }
    }
  }

  /**
   * Evicts the oldest entry when the map is at capacity.
   *
   * `Map` preserves insertion order, so the first entry yielded by the
   * iterator is always the oldest.
   */
  private evictOldest(): void {
    const firstKey = this.inFlight.keys().next().value as OperationKey | undefined;
    if (firstKey !== undefined) {
      const op = this.inFlight.get(firstKey);
      if (op) {
        op.controller.abort();
        this.inFlight.delete(firstKey);
      }
    }
  }
}

export const globalInFlightTracker = /* @__PURE__ */ new InFlightTracker();
