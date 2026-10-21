/**
 * Tests for issue #525: RequestQueue doesn't handle queue size limits,
 * allowing unbounded growth.
 *
 * Fix: RequestQueue accepts a `maxQueueSize` option (default 1000) and
 * rejects excess requests with a RequestQueueOverflowError instead of
 * letting the pending list grow without bound.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_QUEUE_SIZE,
  RequestQueue,
} from '../src/requestQueue';
import { RequestQueueOverflowError } from '../src/errors';

/** A promise plus its resolve/reject handles, for deterministic queue control. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('RequestQueue maxQueueSize (#525)', () => {
  it('defaults to DEFAULT_MAX_QUEUE_SIZE (1000)', () => {
    expect(DEFAULT_MAX_QUEUE_SIZE).toBe(1_000);
  });

  it('validates maxQueueSize at construction time', () => {
    expect(() => new RequestQueue({ maxQueueSize: 0 })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxQueueSize: -1 })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxQueueSize: 1.5 })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxQueueSize: NaN })).toThrow(RangeError);
    expect(() => new RequestQueue({ maxQueueSize: 1 })).not.toThrow();
  });

  it('rejects requests beyond maxQueueSize with RequestQueueOverflowError', async () => {
    // maxConcurrent 1 so only the first request starts; the rest queue up.
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 100, maxQueueSize: 2 });

    const gate = deferred();
    const run = () => gate.promise;

    const first = queue.enqueue(run); // starts immediately (active = 1)
    const second = queue.enqueue(run); // pending = 1
    const third = queue.enqueue(run); // pending = 2 (queue now full)

    // Beyond the cap: rejected, not queued.
    const overflow = queue.enqueue(run);
    await expect(overflow).rejects.toBeInstanceOf(RequestQueueOverflowError);
    await expect(overflow).rejects.toMatchObject({ maxQueueSize: 2 });

    // The accepted requests are unaffected once the gate opens.
    gate.resolve();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
  });

  it('frees capacity as queued requests are processed', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 100, maxQueueSize: 1 });

    const gateA = deferred();
    const gateB = deferred();
    const a = queue.enqueue(() => gateA.promise); // starts (active = 1)
    const b = queue.enqueue(() => gateB.promise); // pending = 1 (full)

    await expect(queue.enqueue(() => gateB.promise)).rejects.toBeInstanceOf(
      RequestQueueOverflowError,
    );

    // Finishing A drains B from the pending list, freeing a slot.
    gateA.resolve();
    await a;
    // Give the queue a microtask to start B and drain pending.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const c = queue.enqueue(async () => 'c');
    gateB.resolve();
    await expect(b).resolves.toBeUndefined();
    await expect(c).resolves.toBe('c');
  });

  it('an aborted pending request frees a slot for new submissions', async () => {
    const queue = new RequestQueue({ maxConcurrent: 1, requestsPerSecond: 100, maxQueueSize: 1 });

    const gate = deferred();
    const controller = new AbortController();

    const a = queue.enqueue(() => gate.promise);
    const b = queue.enqueue(() => gate.promise, undefined, controller.signal);

    controller.abort(new Error('caller aborted'));
    await expect(b).rejects.toThrow('caller aborted');

    // The aborted request was dropped from pending, so a new one fits.
    const c = queue.enqueue(async () => 'c');
    gate.resolve();
    await expect(a).resolves.toBeUndefined();
    await expect(c).resolves.toBe('c');
  });

  it('applies the cap to queues sharing the same account core', async () => {
    const queue1 = new RequestQueue({
      account: 'acct-525',
      maxConcurrent: 1,
      requestsPerSecond: 100,
      maxQueueSize: 1,
    });
    const queue2 = new RequestQueue({
      account: 'acct-525',
      maxConcurrent: 1,
      requestsPerSecond: 100,
      maxQueueSize: 1,
    });

    const gate = deferred();
    const a = queue1.enqueue(() => gate.promise); // starts via shared core
    const b = queue2.enqueue(() => gate.promise); // pending = 1 on shared core

    // The shared core is full — overflow from the second queue instance.
    await expect(queue2.enqueue(() => gate.promise)).rejects.toBeInstanceOf(
      RequestQueueOverflowError,
    );

    gate.resolve();
    await expect(a).resolves.toBeUndefined();
    await expect(b).resolves.toBeUndefined();

    queue1.release();
    queue2.release();
  });

  it('the default-cap queue still processes normally-sized workloads', async () => {
    const queue = new RequestQueue();
    // 12 requests across the default 10 req/s rate limit — well under the cap.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_unused, i) => queue.enqueue(async () => i)),
    );
    expect(results).toEqual(Array.from({ length: 12 }, (_unused, i) => i));
  });
});
