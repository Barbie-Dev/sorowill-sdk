/**
 * Tests for issue #531: HookManager doesn't validate hook callback return
 * values — beforeInvoke hooks could return arbitrary values (strings,
 * numbers, objects, `null`) without any error, causing confusion about
 * whether the return value influenced the invocation.
 *
 * Acceptance criteria:
 * - Return type validation for beforeInvoke hooks
 * - Clear error naming the offending type if a non-boolean/non-void is returned
 * - Test covers the violation
 */

import { describe, expect, it, vi } from 'vitest';

import { HookExecutionError } from '../src/errors';
import { HookManager } from '../src/hooks';
import type { BeforeInvokeContext, BeforeInvokeHook } from '../src/hooks';

const makeCtx = (method = 'check_in'): BeforeInvokeContext => ({
  method,
  args: { will_id: 1n },
  timestamp: new Date().toISOString(),
});

/** Registers a hook whose return value violates the documented contract. */
function registerViolatingHook(hooks: HookManager, returnValue: unknown): void {
  hooks.onBeforeInvoke((() => returnValue) as unknown as BeforeInvokeHook);
}

describe('HookManager — issue #531: hook return value validation', () => {
  // ── violations are rejected ────────────────────────────────────────────────

  it('rejects a beforeInvoke hook that returns a string', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, 'unexpected');

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('rejects a beforeInvoke hook that returns a number', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, 42);

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('rejects a beforeInvoke hook that returns an object', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, { abort: true });

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('rejects a beforeInvoke hook that returns null', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, null);

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  it('rejects an async hook that resolves to a non-boolean value', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke((async () => {
      await Promise.resolve();
      return 'nope';
    }) as unknown as BeforeInvokeHook);

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
  });

  // ── clear error message ────────────────────────────────────────────────────

  it('error message names the offending return type and the allowed contract', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, 'unexpected');

    let caught: unknown;
    try {
      await hooks.runBeforeInvoke(makeCtx());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HookExecutionError);
    const err = caught as HookExecutionError;
    expect(err.hookName).toBe('beforeInvoke');
    expect(err.message).toContain('beforeInvoke hook returned a value of type "string"');
    expect(err.message).toContain('boolean');
    expect(err.message).toContain('void');
  });

  it('error message reports "null" for a null return value', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, null);

    let caught: unknown;
    try {
      await hooks.runBeforeInvoke(makeCtx());
    } catch (err) {
      caught = err;
    }

    expect((caught as HookExecutionError).message).toContain('type "null"');
  });

  it('cause is a TypeError describing the violation', async () => {
    const hooks = new HookManager();
    registerViolatingHook(hooks, 42);

    let caught: unknown;
    try {
      await hooks.runBeforeInvoke(makeCtx());
    } catch (err) {
      caught = err;
    }

    expect((caught as HookExecutionError).cause).toBeInstanceOf(TypeError);
  });

  it('stops executing subsequent hooks after a return-value violation', async () => {
    const hooks = new HookManager();
    const second = vi.fn();
    registerViolatingHook(hooks, 'bad');
    hooks.onBeforeInvoke(second);

    await expect(hooks.runBeforeInvoke(makeCtx())).rejects.toBeInstanceOf(
      HookExecutionError,
    );
    expect(second).not.toHaveBeenCalled();
  });

  // ── allowed return values keep working ─────────────────────────────────────

  it('proceeds when a hook returns undefined (void)', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => {});

    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(true);
  });

  it('proceeds when a hook returns true', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => true);

    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(true);
  });

  it('aborts when a hook returns false', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(() => false);

    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(false);
  });

  it('proceeds when an async hook resolves to undefined', async () => {
    const hooks = new HookManager();
    hooks.onBeforeInvoke(async () => {
      await Promise.resolve();
    });

    await expect(hooks.runBeforeInvoke(makeCtx())).resolves.toBe(true);
  });
});
