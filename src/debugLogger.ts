interface DebugLog {
  timestamp: string;
  level: 'operation-build' | 'simulation' | 'submission' | 'poll' | 'success' | 'error';
  method: string;
  willId?: string | undefined;
  details: Record<string, unknown>;
}

export class DebugLogger {
  constructor(private enabled: boolean) {}

  logOperationBuild(method: string, willId?: string, details?: Record<string, unknown>): void {
    if (!this.enabled) return;

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
    willId?: string,
    minResourceFee?: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.enabled) return;

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
    if (!this.enabled) return;

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
    if (!this.enabled) return;

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
    if (!this.enabled) return;

    const log: DebugLog = {
      timestamp: new Date().toISOString(),
      level: 'success',
      method,
      willId,
      details: { txHash, durationMs },
    };

    this.log(log);
  }

  logError(method: string, willId?: string, error?: string | Error): void {
    if (!this.enabled) return;

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

  private log(log: DebugLog): void {
    // Structured, JSON-serializable output covering multiple log levels
    // (not just warn/error), so console.log is intentional here.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(log));
  }
}
