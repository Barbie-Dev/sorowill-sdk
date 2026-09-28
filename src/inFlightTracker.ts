type OperationKey = string;
type OperationResult<T> = Promise<T>;

interface InFlightOperation<T> {
  promise: OperationResult<T>;
  controller: AbortController;
  /** Wall-clock ms when this entry was added. Used for TTL eviction (issue #487). */
  createdAt: number;
}

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
export const globalInFlightTracker = /* @__PURE__ */ new InFlightTracker();

export class InFlightTracker {
  private readonly inFlight = new Map<OperationKey, InFlightOperation<unknown>>();
  private readonly failedSequences = new Map<OperationKey, FailedOperation>();

  getKey(willId: string | bigint, method: string, clientId?: string): OperationKey {
    const id = typeof willId === 'bigint' ? willId.toString() : willId;
    const scope = clientId ?? '';
    return `${scope}:${id}:${method}`;
  }

  isInFlight(willId: string | bigint, method: string, clientId?: string): boolean {
    return this.inFlight.has(this.getKey(willId, method, clientId));
  }

  getInFlightPromise<T>(
    willId: string | bigint,
    method: string,
    clientId?: string,
  ): OperationResult<T> | undefined {
    const op = this.inFlight.get(this.getKey(willId, method, clientId));
    return op?.promise as OperationResult<T> | undefined;
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
  ): PromiseLike<T> {
    const key = this.getKey(willId, method, clientId);

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
    const entry = { controller } as InFlightOperation<T>;
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
  ): PromiseLike<T> | undefined {
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
