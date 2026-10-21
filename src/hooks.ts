import { HookExecutionError, HookRecursionError } from './errors';

/**
 * Contains all information about the contract call about to be made.
 */
export interface BeforeInvokeContext {
  /** The contract method name being invoked (e.g. 'create_will'). */
  method: string;
  /** The arguments being passed to the contract method. */
  args: Record<string, unknown>;
  /** ISO-8601 timestamp of when the invocation was initiated. */
  timestamp: string;
}

/**
 * Context object passed to afterInvoke hooks.
 * Contains the result or error of the completed contract call.
 */
export interface AfterInvokeContext {
  /** The contract method name that was invoked. */
  method: string;
  /** The arguments that were passed to the contract method. */
  args: Record<string, unknown>;
  /** ISO-8601 timestamp of when the invocation completed. */
  timestamp: string;
  /** The transaction hash, if the invocation succeeded. */
  txHash: string | null;
  /** The error message, if the invocation failed. */
  error: string | null;
  /** Wall-clock duration of the invocation in milliseconds. */
  durationMs: number;
}

/**
 * A function that runs before a contract call is submitted.
 *
 * Return contract (validated at runtime by {@link HookManager}):
 * - `false` — abort the invocation.
 * - `true` or `undefined` (void) — proceed with the invocation.
 *
 * Any other return value (string, number, object, `null`, …) is rejected with
 * a {@link HookExecutionError} so that accidental return values (e.g. the
 * boolean from `Map.set()` or `array.push()`) cannot silently change — or
 * appear to change — the control flow of an invocation.
 */
export type BeforeInvokeHook = (ctx: BeforeInvokeContext) => boolean | void | Promise<boolean | void>;

/**
 * A function that runs after a contract call completes (success or failure).
 * The return value is ignored; hooks must not return anything meaningful.
 */
export type AfterInvokeHook = (ctx: AfterInvokeContext) => void | Promise<void>;

/**
 * Registered hooks for before/after invoke events.
 */
export interface HookRegistry {
  beforeInvoke: BeforeInvokeHook[];
  afterInvoke: AfterInvokeHook[];
}

/**
 * Manages beforeInvoke and afterInvoke hooks for a {@link SoroWillClient}.
 *
 * @example
 * ```ts
 * const hooks = new HookManager();
 *
 * hooks.onBeforeInvoke((ctx) => {
 *   console.log(`Calling ${ctx.method}`, ctx.args);
 * });
 *
 * hooks.onAfterInvoke((ctx) => {
 *   console.log(`${ctx.method} completed in ${ctx.durationMs}ms`);
 * });
 *
 * const client = new SoroWillClient({ network: 'testnet', contractId: '...', hooks });
 * ```
 */
export class HookManager {
  private readonly registry: HookRegistry = {
    beforeInvoke: [],
    afterInvoke: [],
  };

  /**
   * Set while `runBeforeInvoke` or `runAfterInvoke` is actively executing.
   * Used to detect and reject re-entrant (recursive) hook execution, where a
   * hook triggers another contract invocation through the same client.
   */
  private executing = false;

  /** Register a hook that runs before every contract invocation. */
  onBeforeInvoke(hook: BeforeInvokeHook): void {
    this.registry.beforeInvoke.push(hook);
  }

  /** Register a hook that runs after every contract invocation. */
  onAfterInvoke(hook: AfterInvokeHook): void {
    this.registry.afterInvoke.push(hook);
  }

  /** Remove all occurrences of a previously registered beforeInvoke hook. */
  offBeforeInvoke(hook: BeforeInvokeHook): void {
    let idx = this.registry.beforeInvoke.indexOf(hook);
    while (idx !== -1) {
      this.registry.beforeInvoke.splice(idx, 1);
      idx = this.registry.beforeInvoke.indexOf(hook);
    }
  }

  /** Remove all occurrences of a previously registered afterInvoke hook. */
  offAfterInvoke(hook: AfterInvokeHook): void {
    let idx = this.registry.afterInvoke.indexOf(hook);
    while (idx !== -1) {
      this.registry.afterInvoke.splice(idx, 1);
      idx = this.registry.afterInvoke.indexOf(hook);
    }
  }

  /** Remove all registered hooks. */
  clear(): void {
    this.registry.beforeInvoke.length = 0;
    this.registry.afterInvoke.length = 0;
  }

  /**
   * @internal Guard for the documented return contract of hook callbacks.
   *
   * `beforeInvoke` hooks may only return `boolean` (control the invocation) or
   * `undefined`/void (proceed). Anything else is a programming error — e.g.
   * `hooks.onBeforeInvoke((ctx) => cache.set(ctx.method, true))` returns the
   * `boolean` from `Map.set()` that the author never intended to expose — and
   * is rejected here with a clear {@link HookExecutionError} instead of being
   * silently ignored.
   */
  private static assertAllowedHookReturnValue(result: unknown, hookName: string): void {
    if (result === undefined || typeof result === 'boolean') {
      return;
    }

    const receivedType = result === null ? 'null' : typeof result;
    throw new HookExecutionError(
      hookName,
      new TypeError(
        `${hookName} hook returned a value of type "${receivedType}" — hooks must return ` +
          `a boolean (false aborts the invocation) or void (proceeds).`,
      ),
    );
  }

  /** @internal Run all beforeInvoke hooks. Returns `false` if any hook aborted.
   * If any hook throws, the error is wrapped in a `HookExecutionError` and
   * re-thrown immediately. The transaction is not built or submitted when a
   * hook throws — the client state is unchanged.
   *
   * A hook that returns anything other than a boolean or void is rejected with
   * a `HookExecutionError` whose message names the offending return type.
   */
  async runBeforeInvoke(ctx: BeforeInvokeContext): Promise<boolean> {
    if (this.executing) {
      throw new HookRecursionError();
    }
    this.executing = true;
    try {
      for (const hook of this.registry.beforeInvoke) {
        let result: boolean | void;
        try {
          result = await hook(ctx);
        } catch (err) {
          // Let recursion errors propagate unwrapped so callers can catch them
          // directly; wrap any other hook error as before.
          if (err instanceof HookRecursionError) throw err;
          throw new HookExecutionError('beforeInvoke', err);
        }
        if (result === false) return false;
      }
      return true;
    } finally {
      this.executing = false;
    }
  }

  /**
   * @internal Run all afterInvoke hooks. A throwing hook is swallowed rather
   * than propagated — afterInvoke hooks are instrumentation/observability
   * side effects, and a broken one must never convert an otherwise-successful
   * (or already-failed) invocation into a different outcome for the caller.
   * Every hook still runs exactly once, in order, even if an earlier one throws.
   */
  async runAfterInvoke(ctx: AfterInvokeContext): Promise<void> {
    if (this.executing) {
      throw new HookRecursionError();
    }
    this.executing = true;
    try {
      for (const hook of this.registry.afterInvoke) {
        try {
          await hook(ctx);
        } catch (err) {
          // Let recursion errors propagate unwrapped; swallow any other hook
          // error — afterInvoke is instrumentation and must not break the call.
          if (err instanceof HookRecursionError) throw err;
        }
      }
    } finally {
      this.executing = false;
    }
  }

  /** The number of registered beforeInvoke hooks. */
  get beforeInvokeCount(): number {
    return this.registry.beforeInvoke.length;
  }

  /** The number of registered afterInvoke hooks. */
  get afterInvokeCount(): number {
    return this.registry.afterInvoke.length;
  }
}
