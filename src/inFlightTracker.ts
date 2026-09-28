type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
  /** Wall-clock ms when this entry was added. Used for TTL eviction (issue #487). */
  createdAt: number;
}

/**
 * Maximum number of entries the in-flight map is allowed to hold simultaneously
 * before the oldest entry is evicted (issue #487).
 *
 * In practice a well-behaved application will never approach this ceiling
 * because completed entries are removed via `.finally()`.  The cap exists as a
 * last-resort safety net for entries whose promises are somehow never settled
 * (e.g. a dangling reference prevents garbage collection).
 */
const DEFAULT_MAX_IN_FLIGHT = 1_000;

/**
 * Time-to-live in milliseconds for an in-flight entry that has not been
 * resolved or rejected via its own `.finally()` handler (issue #487).
 *
 * Five minutes is generous enough to accommodate any realistic Soroban
 * transaction lifecycle (submit → poll → finalise) while still bounding
 * memory usage for long-running keeper bots or backend services.
 */
const DEFAULT_TTL_MS = 5 * 60 * 1_000;

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();
  private readonly maxInFlight: number;
  private readonly ttlMs: number;

  constructor(maxInFlight: number = DEFAULT_MAX_IN_FLIGHT, ttlMs: number = DEFAULT_TTL_MS) {
    this.maxInFlight = maxInFlight;
    this.ttlMs = ttlMs;
  }

  getKey(willId: string | bigint, method: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    return `${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string): boolean {
    const key = this.getKey(willId, method);
    const op = this.inFlight.get(key);
    if (!op) return false;
    // Treat TTL-expired entries as no longer in-flight and evict them lazily.
    if (this.isExpired(op)) {
      this.evict(key, op);
      return false;
    }
    return true;
  }

  getInFlightPromise<T>(willId: string | bigint, method: string): OperationResult<T> | undefined {
    const key = this.getKey(willId, method);
    const op = this.inFlight.get(key);
    if (!op) return undefined;
    if (this.isExpired(op)) {
      this.evict(key, op);
      return undefined;
    }
    return op.promise as OperationResult<T> | undefined;
  }

  track<T>(
    willId: string | bigint,
    method: string,
    operation: (signal: AbortSignal) => PromiseLike<T>,
  ): PromiseLike<T> {
    const key = this.getKey(willId, method);

    const existing = this.inFlight.get(key);
    if (existing) {
      if (!this.isExpired(existing)) {
        return existing.promise as PromiseLike<T>;
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
    const promise = Promise.resolve(operation(controller.signal)).finally(() => {
      // Primary cleanup path: remove the entry as soon as the operation settles.
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, { promise, controller, createdAt: Date.now() });
    return promise;
  }

  clear(): void {
    for (const { controller } of this.inFlight.values()) {
      controller.abort();
    }
    this.inFlight.clear();
  }

  abort(willId: string | bigint, method: string): void {
    const key = this.getKey(willId, method);
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
