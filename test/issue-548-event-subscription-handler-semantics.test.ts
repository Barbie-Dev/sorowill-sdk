/**
 * Tests for issue #548: `EventSubscription` type doesn't enforce that only one
 * handler runs per event.
 *
 * Fix: the documented semantics are now explicit and enforced by the
 * implementation:
 *
 * - A subscription has exactly one handler (the `listener` passed to
 *   `subscribeToEvents()`); the returned handle exposes no way to attach
 *   another one.
 * - Events are delivered to that handler in stream order, strictly
 *   sequentially — the next event is not dispatched until the listener for the
 *   previous one has returned.
 * - A throwing listener is isolated to its own event: the subscription stays
 *   open, the remaining events are still delivered, and the failure is
 *   reported through `EventSubscriptionOptions.onError`. This holds for both
 *   the WebSocket and the polling transport.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SoroWillClient } from '../src/SoroWillClient';
import type { EventSubscription } from '../src/types';

/** Minimal stand-in for the SDK's internal `WebSocketLike` shape. */
type MockWebSocket = {
  send: (data: string) => void;
  close: () => void;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
};

function makeWebSocket(): { socket: MockWebSocket; close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const socket: MockWebSocket = {
    send: vi.fn(),
    close,
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  return { socket, close };
}

function eventPayload(...ids: string[]): string {
  return JSON.stringify({
    result: {
      events: ids.map((id) => ({
        id,
        type: 'willCreated',
        ledger: 1,
        contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      })),
    },
  });
}

describe('issue #548 — event subscription handler semantics', () => {
  let socket: MockWebSocket;
  let close: ReturnType<typeof vi.fn>;
  let client: SoroWillClient;

  beforeEach(() => {
    ({ socket, close } = makeWebSocket());
    client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      webSocketFactory: () => socket,
      eventStreamUrl: 'ws://test-stream.local',
    });
  });

  it('exposes no API for attaching a second handler to a subscription', async () => {
    const subscriptionPromise = client.subscribeToEvents(() => {}, { transport: 'websocket' });
    socket.onopen?.();
    const subscription: EventSubscription = await subscriptionPromise;

    for (const method of ['on', 'addHandler', 'addListener', 'subscribe', 'off'] as const) {
      expect((subscription as unknown as Record<string, unknown>)[method]).toBeUndefined();
    }
    expect(typeof subscription.unsubscribe).toBe('function');
    expect(typeof subscription.close).toBe('function');
  });

  it('delivers each event to the single handler exactly once', async () => {
    const listener = vi.fn();
    const subscriptionPromise = client.subscribeToEvents(listener, { transport: 'websocket' });
    socket.onopen?.();
    await subscriptionPromise;

    socket.onmessage?.({ data: eventPayload('e1', 'e2') });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener.mock.calls.map(([event]) => event.id)).toEqual(['e1', 'e2']);
  });

  it('delivers events sequentially, in stream order', async () => {
    const seen: string[] = [];
    const subscriptionPromise = client.subscribeToEvents(
      (event) => {
        seen.push(event.id);
      },
      { transport: 'websocket' },
    );
    socket.onopen?.();
    await subscriptionPromise;

    socket.onmessage?.({ data: eventPayload('e1', 'e2', 'e3') });

    expect(seen).toEqual(['e1', 'e2', 'e3']);
  });

  it('isolates a throwing listener: the subscription stays open and later events still arrive', async () => {
    const onError = vi.fn();
    const seen: string[] = [];
    const subscriptionPromise = client.subscribeToEvents(
      (event) => {
        if (event.id === 'bad') {
          throw new Error('listener boom');
        }
        seen.push(event.id);
      },
      { transport: 'websocket', onError },
    );
    socket.onopen?.();
    const subscription = await subscriptionPromise;

    socket.onmessage?.({ data: eventPayload('bad', 'good') });

    expect(seen).toEqual(['good']);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported).toBeInstanceOf(Error);
    expect(reported?.message).toContain('Event listener threw');
    expect(subscription.closed).toBe(false);
  });

  it('keeps the subscription usable after a listener error', async () => {
    const onError = vi.fn();
    const listener = vi.fn(() => {
      throw new Error('listener boom');
    });
    const subscriptionPromise = client.subscribeToEvents(listener, {
      transport: 'websocket',
      onError,
    });
    socket.onopen?.();
    const subscription = await subscriptionPromise;

    socket.onmessage?.({ data: eventPayload('e1') });
    socket.onmessage?.({ data: eventPayload('e2') });

    expect(listener).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(subscription.closed).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener on the polling transport too', async () => {
    const onError = vi.fn();
    const seen: string[] = [];
    const pollingClient = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      fetch: async () =>
        new Response(
          JSON.stringify({
            result: {
              events: [
                { id: 'bad', type: 'willCreated', ledger: 1 },
                { id: 'good', type: 'willCreated', ledger: 2 },
              ],
              nextCursor: '2',
            },
          }),
        ),
    });

    await pollingClient.subscribeToEvents(
      (event) => {
        if (event.id === 'bad') {
          throw new Error('listener boom');
        }
        seen.push(event.id);
      },
      { transport: 'polling', onError },
    );

    expect(seen).toEqual(['good']);
    expect(onError).toHaveBeenCalledTimes(1);
    const reported = onError.mock.calls[0]?.[0];
    expect(reported?.message).toContain('Event listener threw');
  });
});
