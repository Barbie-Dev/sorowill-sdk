/**
 * Tests for issue #535: DebugLogger doesn't suppress output based on log
 * level environment variable.
 *
 * Acceptance criteria:
 * - Log level environment variable supported (SOROWILL_LOG_LEVEL)
 * - Filtering by level
 * - Test covers levels
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogger } from '../src/debugLogger';

describe('DebugLogger issue 535: log level filtering', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env['NODE_ENV'] = 'test';
  });
  afterEach(() => {
    consoleLogSpy.mockRestore();
    delete process.env['SOROWILL_LOG_LEVEL'];
    delete process.env['NODE_ENV'];
    delete process.env['SOROWILL_DEBUG'];
  });
  it('defaults minLevel to debug (all levels logged)', () => {
    const logger = new DebugLogger(true);
    expect(logger.minLevel).toBe('debug');
    logger.logOperationBuild('m', '1');
    logger.logSimulation('m', '1', '100');
    logger.logSubmission('m', '1', 'tx');
    logger.logPoll('m', '1', 1, 5);
    logger.logSuccess('m', '1', 'tx', 1);
    logger.logError('m', '1', 'err');
    expect(consoleLogSpy).toHaveBeenCalledTimes(6);
  });
  it('SOROWILL_LOG_LEVEL=error: only error entries emitted', () => {
    process.env['SOROWILL_LOG_LEVEL'] = 'error';
    const logger = new DebugLogger(true);
    expect(logger.minLevel).toBe('error');
    logger.logOperationBuild('m', '1');
    logger.logSimulation('m', '1', '100');
    logger.logSubmission('m', '1', 'tx');
    logger.logPoll('m', '1', 1, 5);
    logger.logSuccess('m', '1', 'tx', 1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    logger.logError('m', '1', 'boom');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });
  it('SOROWILL_LOG_LEVEL=info: debug suppressed, info+ kept', () => {
    process.env['SOROWILL_LOG_LEVEL'] = 'info';
    const logger = new DebugLogger(true);
    logger.logSimulation('m', '1', '100');
    logger.logPoll('m', '1', 1, 5);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    logger.logOperationBuild('m', '1');
    logger.logSubmission('m', '1', 'tx');
    logger.logSuccess('m', '1', 'tx', 1);
    logger.logError('m', '1', 'err');
    expect(consoleLogSpy).toHaveBeenCalledTimes(4);
  });
  it('SOROWILL_LOG_LEVEL=warn: info suppressed, error kept', () => {
    process.env['SOROWILL_LOG_LEVEL'] = 'warn';
    const logger = new DebugLogger(true);
    logger.logOperationBuild('m', '1');
    logger.logSuccess('m', '1', 'tx', 1);
    expect(consoleLogSpy).not.toHaveBeenCalled();
    logger.logError('m', '1', 'err');
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
  });
  it('normalizes case/whitespace, falls back to debug for unknown', () => {
    process.env['SOROWILL_LOG_LEVEL'] = '  ERROR  ';
    expect(new DebugLogger(true).minLevel).toBe('error');
    process.env['SOROWILL_LOG_LEVEL'] = 'verbose';
    expect(new DebugLogger(true).minLevel).toBe('debug');
    process.env['SOROWILL_LOG_LEVEL'] = '';
    expect(new DebugLogger(true).minLevel).toBe('debug');
  });
});
