/**
 * Log severity levels used by {@link DebugLogger} for filtering output.
 *
 * Levels are ordered from most severe (lowest priority number) to least
 * severe (highest priority number). A logger configured with a minimum level
 * suppresses all entries below that threshold.
 *
 * @since 0.1.2
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

/**
 * Priority rank for each {@link LogLevel}. Lower numbers are more severe and
 * are always logged when their threshold is met or exceeded.
 */
const SEVERITY_PRIORITY: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

/**
 * Default minimum severity. `debug` preserves the existing behavior (all
 * levels logged when the logger is active). Set `SOROWILL_LOG_LEVEL` to a
 * more severe level (e.g. `error`) to suppress less important output.
 */
const DEFAULT_LOG_LEVEL: LogLevel = 'debug';

/**
 * Resolves the minimum log severity from the `SOROWILL_LOG_LEVEL` environment
 * variable. Falls back to {@link DEFAULT_LOG_LEVEL} when the variable is
 * unset, empty, or contains an unrecognized value.
 */
function resolveLogLevel(): LogLevel {
  const raw =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    typeof process.env['SOROWILL_LOG_LEVEL'] === 'string'
      ? process.env['SOROWILL_LOG_LEVEL'].trim().toLowerCase()
      : undefined;
  if (raw && raw in SEVERITY_PRIORITY) {
    return raw as LogLevel;
  }
  return DEFAULT_LOG_LEVEL;
}

/**
 * Determines whether debug logging should be active based on environment.
 *
 * Logging is active when ALL of the following are true:
 *  1. The `enabled` flag passed to the constructor is `true`.
 *  2. The runtime is NOT in production mode. Production mode is detected when
 *     `process.env.NODE_ENV` is `"production"` (Node.js) or
 *     `import.meta.env?.MODE` is `"production"` (Vite / browser bundlers).
 *
 * The production guard is a safety net: even if a caller accidentally passes
 * `debug: true` to `SoroWillClient` in a production build, no logs will be
 * emitted. Production logging must be routed through a proper observability
 * pipeline — not the browser console.
 *
 * To enable debug logs in a Node.js environment you can also set the
 * `SOROWILL_DEBUG` environment variable to any non-empty value. This is
 * useful in CI scripts and automated tests where passing a constructor flag
 * is not convenient.
 */
function resolveEnabled(explicitFlag: boolean): boolean {
  // Check for SOROWILL_DEBUG env var (Node.js) as an alternative activation path.
  const envFlag =
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    Boolean(process.env['SOROWILL_DEBUG']);

  const active = explicitFlag || envFlag;
  if (!active) return false;

  // Production guard — suppress even if explicitly enabled.
  const isProduction = isProductionEnvironment();
  return !isProduction;
}

/** Returns `true` when running in a known production environment. */
function isProductionEnvironment(): boolean {
  // Node.js / server-side check.
  if (
    typeof process !== 'undefined' &&
    typeof process.env !== 'undefined' &&
    process.env['NODE_ENV'] === 'production'
  ) {
    return true;
  }

  // Vite / browser bundler check (import.meta.env is replaced at build time).
  if (
    typeof globalThis !== 'undefined' &&
    typeof import.meta !== 'undefined' &&
    // @ts-expect-error — import.meta.env is only available in bundler contexts
    typeof import.meta.env !== 'undefined' &&
    // @ts-expect-error — not typed in the generic tsconfig
    (import.meta.env as Record<string, unknown>)['MODE'] === 'production'
  ) {
    return true;
  }

  return false;
}

/**
 * Field names whose values are redacted from debug logs by default.
 *
 * Matching is case-insensitive and ignores `_` and `-`, and a field is
 * redacted when its normalized name *contains* any entry, so `privateKey`,
 * `private_key` and `signerPrivateKey` are all caught by `privateKey`.
 */
export const DEFAULT_REDACTED_KEYS: readonly string[] = Object.freeze([
  'secret',
  'privateKey',
  'seed',
  'mnemonic',
  'password',
  'apiKey',
  'accessToken',
  'authToken',
  'refreshToken',
  'authorization',
  'cookie',
]);

/** Placeholder written in place of a redacted value. */
export const REDACTED = '[REDACTED]';

/**
 * Stellar secret seeds (`S` + 55 base32 chars). Redacted wherever they appear
 * in a logged string, including error messages and stack traces.
 */
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/** Options controlling how {@link DebugLogger} sanitizes log output. */
export interface DebugLoggerOptions {
  /**
   * Redact sensitive fields and Stellar secret seeds from log output.
   * Defaults to `true`. Set to `false` only in a trusted local environment.
   */
  readonly redact?: boolean;
  /** Extra field names to redact, in addition to {@link DEFAULT_REDACTED_KEYS}. */
  readonly redactKeys?: readonly string[];
  /**
   * Replace {@link DEFAULT_REDACTED_KEYS} with `redactKeys` instead of
   * extending it. Defaults to `false`.
   */
  readonly replaceDefaultRedactKeys?: boolean;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function redactString(value: string): string {
  return value.replace(STELLAR_SECRET_SEED_PATTERN, REDACTED);
}

interface DebugLog {
  timestamp: string;
  level: 'operation-build' | 'simulation' | 'submission' | 'poll' | 'success' | 'error';
  /** Severity used for filtering against the configured minimum level. */
  severity?: LogLevel;
  method: string;
  willId?: string | undefined;
  details: Record<string, unknown>;
}

/**
 * Maps each {@link DebugLog.level} to its {@link LogLevel} severity so the
 * `log()` method can filter entries below the configured minimum threshold.
 */
const LEVEL_SEVERITY: Record<DebugLog['level'], LogLevel> = {
  'operation-build': 'info',
  simulation: 'debug',
  submission: 'info',
  poll: 'debug',
  success: 'info',
  error: 'error',
};

export class DebugLogger {
  /**
   * Whether this logger is currently active.
   *
   * Resolved at construction time from the explicit `enabled` flag, the
   * `SOROWILL_DEBUG` environment variable, and the production-mode guard.
   * Callers may check this property to avoid building expensive log payloads
   * that would otherwise be thrown away immediately.
   */
  readonly isActive: boolean;

  /**
   * Minimum severity this logger will emit. Resolved at construction time
   * from the `SOROWILL_LOG_LEVEL` environment variable (default: `debug`,
   * i.e. everything). Setting `SOROWILL_LOG_LEVEL=error` suppresses all
   * entries except `error`-level ones.
   *
   * @since 0.1.2
   */
  readonly minLevel: LogLevel;

  constructor(enabled: boolean) {
    this.isActive = resolveEnabled(enabled);
    this.minLevel = resolveLogLevel();
  }

  logOperationBuild(method: string, willId: string | undefined = undefined, details: Record<string, unknown> | undefined = undefined): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'operation-build',
      method,
      willId,
      details: details || {},
    };

    this.log(log);
  }

  logSimulation(
    method: string,
    willId: string | undefined = undefined,
    minResourceFee: string | undefined = undefined,
    details: Record<string, unknown> | undefined = undefined,
  ): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'simulation',
      method,
      willId,
      details: {
        minResourceFee,
        ...details,
      },
    };

    this.log(log);
  }

  logSubmission(method: string, willId?: string, txHash?: string): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'submission',
      method,
      willId,
      details: { txHash },
    };

    this.log(log);
  }

  logPoll(method: string, willId?: string, attempt?: number, maxAttempts?: number): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'poll',
      method,
      willId,
      details: { attempt, maxAttempts },
    };

    this.log(log);
  }

  logSuccess(method: string, willId?: string, txHash?: string, durationMs?: number): void {
    if (!this.isActive) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'success',
      method,
      willId,
      details: { txHash, durationMs },
    };

    this.log(log);
  }

  logError(method: string, willId: string | undefined = undefined, error: string | Error | undefined = undefined): void {
    if (!this.isActive) return;

    const errorMessage = error instanceof Error ? error.message : String(error);
    // Stack traces are only captured when debug logging is enabled (checked above).
    const stack = error instanceof Error ? error.stack : undefined;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'error',
      method,
      willId,
      details: { error: errorMessage, stack },
    };

    this.log(log);
  }

  /** Returns `true` when values under `key` should be redacted. */
  private isSensitiveKey(key: string): boolean {
    const normalized = normalizeKey(key);
    return this.redactKeys.some((pattern) => normalized.includes(pattern));
  }

  /**
   * Recursively copies `value`, replacing sensitive fields with
   * {@link REDACTED} and scrubbing Stellar secret seeds from strings.
   */
  private sanitize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
    if (typeof value === 'string') {
      return redactString(value);
    }
    if (typeof value === 'bigint') {
      return value.toString();
    }
    if (value === null || typeof value !== 'object') {
      return value;
    }
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitize(item, seen));
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = this.isSensitiveKey(key) ? REDACTED : this.sanitize(item, seen);
    }
    return result;
  }

  private log(log: DebugLog): void {
    const severity: LogLevel = log.severity ?? LEVEL_SEVERITY[log.level];
    if (SEVERITY_PRIORITY[severity] > SEVERITY_PRIORITY[this.minLevel]) return;
    // Structured, JSON-serializable output covering multiple log levels
    // (not just warn/error), so console.log is intentional here.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(log));
  }
}
