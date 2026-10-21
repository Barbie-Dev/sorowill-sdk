import { RequestQueueOverflowError, RequestTimeoutError } from './errors';

/**
 * Default cap on the number of requests that may be waiting in the queue at
 * once. Requests beyond this limit are rejected with a
 * {@link RequestQueueOverflowError} instead of accumulating without bound (#525).
 */
export const DEFAULT_MAX_QUEUE_SIZE = 1_000;

/**
 * Rate and concurrency controls used by the client's shared RPC request queue.
 *
 * The queue is fair in that it respects both FIFO ordering and request priority:
 * requests are executed in strict FIFO order when they have the same priority.
 * When a request with higher priority is enqueued, it will be executed ahead of
 * lower-priority requests that are already queued, but after any requests that
 * were already being processed.
 */
export interface RequestQueueOptions {
  /** Maximum number of RPC requests in flight at once. Defaults to 4. */
  maxConcurrent?: number;
  /**
   * Maximum number of RPC requests started in any rolling one-second window. Defaults to 10.
   *
   * This enforces rate limiting at the RPC server level. High-priority requests
   * may still be delayed if the rate limit has been exhausted.
   */
  requestsPerSecond?: number;
  /**
   * Maximum number of requests allowed to wait in the queue at once. Defaults
   * to 1000. When the queue is full, further {@link RequestQueue.enqueue}
   * calls are rejected with a {@link RequestQueueOverflowError} instead of
   * growing the queue without bound (#525).
   */
  maxQueueSize?: number;
  /**
   * Optional account key. When provided, all {@link RequestQueue} instances
   * created with the same key share a single underlying queue, so operations
   * for a given account are serialized even if multiple clients (or multiple
   * queues) are created for that account in rapid succession.
   */
  account?: string;
}

/** Priority level for requests in the queue. Higher priority requests are processed first within FIFO ordering constraints. */
export enum RequestPriority {
  /** Low priority for background operations (e.g., UI polling). */
  Low = 0,
  /** Normal priority for regular operations. Default priority. */
  Normal = 1,
  /** High priority for user-initiated operations (e.g., form submissions). */
  High = 2,
}

interface PendingRequest<T> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  priority: RequestPriority;
  enqueuedAt: number;
  method: string | undefined;
}

/**
 * Shared state for a single account. Multiple {@link RequestQueue} instances
 * created for the same account delegate to the same {@link QueueCore}, which
 * guarantees their operations are serialized against one another.
 */
class QueueCore {
  readonly maxConcurrent: number;
  readonly requestsPerSecond: number;
  readonly maxQueueSize: number;
  readonly pending: Array<PendingRequest<unknown>> = [];
  readonly starts: number[] = [];
  active = 0;
  wakeTimer: ReturnType<typeof setTimeout> | undefined;
  refCount = 0;

  constructor(maxConcurrent: number, requestsPerSecond: number, maxQueueSize: number) {
    this.maxConcurrent = maxConcurrent;
    this.requestsPerSecond = requestsPerSecond;
    this.maxQueueSize = maxQueueSize;
  }
}

/**
 * Process-wide registry of shared queue cores keyed by account. This is what
 * makes {@link RequestQueue} effectively a singleton per account: two queues
 * constructed for the same account within milliseconds coordinate through the
 * same core instead of racing each other.
 */
const sharedCores = new Map<string, QueueCore>();

/** FIFO queue that applies concurrency, rate, and timeout limits to asynchronous requests. */
export class RequestQueue {
  private readonly core: QueueCore;
  private readonly account: string | undefined;
  private released = false;

  constructor(options: RequestQueueOptions = {}) {
    const maxConcurrent = options.maxConcurrent ?? 4;
    const requestsPerSecond = options.requestsPerSecond ?? 10;
    const maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrent must be a positive integer');
    }
    if (!Number.isInteger(requestsPerSecond) || requestsPerSecond < 1) {
      throw new RangeError('requestsPerSecond must be a positive integer');
    }
    if (!Number.isInteger(maxQueueSize) || maxQueueSize < 1) {
      throw new RangeError('maxQueueSize must be a positive integer');
    }
    this.account = options.account;
    if (this.account !== undefined) {
      let core = sharedCores.get(this.account);
      if (core === undefined) {
        core = new QueueCore(maxConcurrent, requestsPerSecond, maxQueueSize);
        sharedCores.set(this.account, core);
      }
      core.refCount += 1;
      this.core = core;
    } else {
      this.core = new QueueCore(maxConcurrent, requestsPerSecond, maxQueueSize);
    }
  }

  enqueue<T>(
    run: () => Promise<T>,
    timeoutMs?: number,
    signal?: AbortSignal,
    priority: RequestPriority = RequestPriority.Normal,
    method?: string,
  ): Promise<T> {
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      return Promise.reject(new RangeError('timeoutMs must be greater than zero'));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    // Enforce the queue size cap (#525): when requests are produced faster
    // than concurrency + rate limits allow them to start, reject the excess
    // immediately rather than letting the pending list grow without bound.
    if (this.core.pending.length >= this.core.maxQueueSize) {
      return Promise.reject(new RequestQueueOverflowError(this.core.maxQueueSize));
    }
    return new Promise<T>((resolve, reject) => {
      const request: PendingRequest<T> = {
        run,
        resolve,
        reject,
        timeoutMs,
        signal,
        abortListener: undefined,
        priority,
        enqueuedAt: Date.now(),
        method,
      };
      if (signal) {
        request.abortListener = () => {
          // Drop the request from the queue so an aborted request never runs.
          const index = this.core.pending.indexOf(request as PendingRequest<unknown>);
          if (index !== -1) this.core.pending.splice(index, 1);
          this.removeAbortListener(request);
          reject(signal.reason);
        };
        signal.addEventListener('abort', request.abortListener);
      }
      this.core.pending.push(request as PendingRequest<unknown>);
      this.drain();
    });
  }

  /**
   * Rejects every request that is queued but not yet started, clearing the
   * pending list. Active (already-started) requests are not affected here —
   * callers should abort those separately via {@link InFlightTracker.clear}.
   *
   * Intended to be called by {@link SoroWillClient.destroy} so that any
   * requests enqueued after unmount/teardown do not run to completion.
   */
  rejectAll(reason: unknown): void {
    if (this.core.wakeTimer !== undefined) {
      clearTimeout(this.core.wakeTimer);
      this.core.wakeTimer = undefined;
    }
    const drained = this.core.pending.splice(0);
    for (const request of drained) {
      this.removeAbortListener(request);
      request.reject(reason);
    }
  }

  /**
   * Releases this queue's reference to the shared per-account core. When the
   * last queue for an account is released, the shared core is dropped so a
   * later client for the same account starts from a clean state.
   */
  release(): void {
    if (this.released) return;
    this.released = true;
    if (this.account === undefined) return;
    const core = sharedCores.get(this.account);
    if (core !== this.core) return;
    core.refCount -= 1;
    if (core.refCount <= 0) {
      sharedCores.delete(this.account);
    }
  }

  private removeAbortListener(request: { signal: AbortSignal | undefined; abortListener: (() => void) | undefined }): void {
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener('abort', request.abortListener);
    }
  }

  private drain(): void {
    const core = this.core;
    if (core.wakeTimer !== undefined) {
      clearTimeout(core.wakeTimer);
      core.wakeTimer = undefined;
    }
    const now = Date.now();
    while (core.starts[0] !== undefined && core.starts[0] <= now - 1_000) {
      core.starts.shift();
    }
    while (
      core.active < core.maxConcurrent &&
      core.starts.length < core.requestsPerSecond &&
      core.pending.length > 0
    ) {
      const request = this.selectNextRequest();
      if (request === undefined) break;
      core.active += 1;
      core.starts.push(Date.now());
      this.removeAbortListener(request);
      void this.execute(request);
    }
    if (
      core.pending.length > 0 &&
      core.active < core.maxConcurrent &&
      core.starts[0] !== undefined
    ) {
      const delay = Math.max(1, core.starts[0] + 1_000 - Date.now());
      core.wakeTimer = setTimeout(() => this.drain(), delay);
    }
  }

  private selectNextRequest(): PendingRequest<unknown> | undefined {
    const pending = this.core.pending;
    if (pending.length === 0) {
      return undefined;
    }
    let selectedIndex = 0;
    let selectedPriority = pending[0]!.priority;
    for (let i = 1; i < pending.length; i++) {
      if (pending[i]!.priority > selectedPriority) {
        selectedIndex = i;
        selectedPriority = pending[i]!.priority;
      }
    }
    const [request] = pending.splice(selectedIndex, 1);
    return request;
  }

  private async execute<T>(request: PendingRequest<T>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result =
        request.timeoutMs === undefined
          ? await request.run()
          : await Promise.race([
              request.run(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () =>
                    reject(
                      new RequestTimeoutError(
                        request.timeoutMs as number,
                        request.method,
                      ),
                    ),
                  request.timeoutMs,
                );
              }),
            ]);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.removeAbortListener(request);
      this.core.active -= 1;
      this.drain();
    }
  }
}

const sharedQueueMap = new Map<string, RequestQueue>();

export function getSharedRequestQueue(account?: string): RequestQueue {
  const key = account ?? '__default__';
  if (!sharedQueueMap.has(key)) {
    const opts: RequestQueueOptions = account !== undefined ? { account } : {};
    sharedQueueMap.set(key, new RequestQueue(opts));
  }
  return sharedQueueMap.get(key)!;
}

export function releaseSharedRequestQueue(account?: string): void {
  const key = account ?? '__default__';
  const queue = sharedQueueMap.get(key);
  if (queue) {
    queue.release();
    sharedQueueMap.delete(key);
  }
}
