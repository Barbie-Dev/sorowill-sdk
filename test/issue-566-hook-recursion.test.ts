import { describe, expect, it, vi } from 'vitest';

import { HookRecursionError } from '../src/errors';
import { HookManager } from '../src/hooks';
import type { BeforeInvokeContext, AfterInvokeContext } from '../src/hooks';

const makeBeforeCtx = (method = 'check_in'): BeforeInvokeContext => ({
  method,
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
});

const makeAfterCtx = (method = 'check_in'): AfterInvokeContext => ({
  method,
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
  txHash: null,
  error: null,
  durationMs: 0,
});

describe('HookManager — issue #566: recursive hook execution prevention', () => {
  describe('beforeInvoke re-entrancy', () => {
    it('throws HookRecursionError when a beforeInvoke hook re-enters runBeforeInvoke', async () => {
      const hooks = new HookManager();
      let outerCalls = 0;

      hooks.onBeforeInvoke(async (ctx) => {
        outerCalls++;
        // A hook that triggers another contract invocation through the same
        // client — this must be blocked, not allowed to recurse forever.
        if (outerCalls === 1) {
          await expect(
            hooks.runBeforeInvoke(makeBeforeCtx(ctx.method)),
          ).rejects.toBeInstanceOf(HookRecursionError);
        }
      });

      // The outer invocation completes normally; the nested one is rejected.
      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
      expect(outerCalls).toBe(1);
    });

    it('does not execute hooks from within the blocked nested invocation', async () => {
      const hooks = new HookManager();
      const shared = vi.fn();

      hooks.onBeforeInvoke(async () => {
        // Attempting to nest is blocked before any hook in the nested call runs.
        await expect(
          hooks.runBeforeInvoke(makeBeforeCtx()),
        ).rejects.toBeInstanceOf(HookRecursionError);
      });
      hooks.onBeforeInvoke(shared);

      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);

      // `shared` runs once for the outer invocation; the blocked nested call
      // must not add any further invocations.
      expect(shared).toHaveBeenCalledTimes(1);
    });

    it('HookRecursionError is a SoroWillError with a clear message', async () => {
      const hooks = new HookManager();

      hooks.onBeforeInvoke(async () => {
        await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toMatchObject({
          message: expect.stringContaining('Recursive hook execution'),
        });
      });

      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
    });
  });

  describe('afterInvoke re-entrancy', () => {
    it('throws HookRecursionError when an afterInvoke hook re-enters runAfterInvoke', async () => {
      const hooks = new HookManager();
      let outerCalls = 0;

      hooks.onAfterInvoke(async (ctx) => {
        outerCalls++;
        if (outerCalls === 1) {
          await expect(
            hooks.runAfterInvoke(makeAfterCtx(ctx.method)),
          ).rejects.toBeInstanceOf(HookRecursionError);
        }
      });

      await expect(hooks.runAfterInvoke(makeAfterCtx())).resolves.toBeUndefined();
      expect(outerCalls).toBe(1);
    });

    it('does not execute hooks from within the blocked nested invocation', async () => {
      const hooks = new HookManager();
      const shared = vi.fn();

      hooks.onAfterInvoke(async () => {
        // Attempting to nest is blocked before any hook in the nested call runs.
        await expect(
          hooks.runAfterInvoke(makeAfterCtx()),
        ).rejects.toBeInstanceOf(HookRecursionError);
      });
      hooks.onAfterInvoke(shared);

      await expect(hooks.runAfterInvoke(makeAfterCtx())).resolves.toBeUndefined();

      // `shared` runs once for the outer invocation; the blocked nested call
      // must not add any further invocations.
      expect(shared).toHaveBeenCalledTimes(1);
    });
  });

  describe('recovery after a recursion error', () => {
    it('resets the executing flag so the HookManager stays usable', async () => {
      const hooks = new HookManager();
      const goodHook = vi.fn();

      hooks.onBeforeInvoke(async () => {
        await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toBeInstanceOf(
          HookRecursionError,
        );
      });
      hooks.onBeforeInvoke(goodHook);

      // The recursion error must not poison the manager.
      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
      expect(goodHook).toHaveBeenCalledTimes(1);

      // And again on a fresh invocation.
      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).resolves.toBe(true);
      expect(goodHook).toHaveBeenCalledTimes(2);
    });

    it('still wraps genuine (non-recursive) hook errors in HookExecutionError', async () => {
      const hooks = new HookManager();
      hooks.onBeforeInvoke(() => {
        throw new Error('genuine hook failure');
      });

      await expect(hooks.runBeforeInvoke(makeBeforeCtx())).rejects.toMatchObject({
        name: 'HookExecutionError',
        message: expect.stringContaining('genuine hook failure'),
      });
    });
  });
});
