import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REDACTED_KEYS, DebugLogger, REDACTED } from '../src/debugLogger';

const SECRET_SEED = 'SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN';

function lastLog(spy: ReturnType<typeof vi.spyOn>) {
  const calls = spy.mock.calls;
  return JSON.parse(calls[calls.length - 1][0] as string);
}

describe('Issue #576: DebugLogger redacts sensitive data by default', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('redacts default sensitive fields, including nested and differently-cased keys', () => {
    const logger = new DebugLogger(true);

    logger.logOperationBuild('createWill', '1', {
      secret: 'super_secret',
      signerPrivateKey: 'pk',
      private_key: 'pk2',
      API_KEY: 'key',
      nested: { password: 'pw', mnemonic: 'words', ok: 'visible' },
      list: [{ seed: 'seed' }, 'plain'],
      token: 'CTOKEN',
      owner: 'GOWNER',
    });

    const { details } = lastLog(consoleLogSpy);
    expect(details.secret).toBe(REDACTED);
    expect(details.signerPrivateKey).toBe(REDACTED);
    expect(details.private_key).toBe(REDACTED);
    expect(details.API_KEY).toBe(REDACTED);
    expect(details.nested.password).toBe(REDACTED);
    expect(details.nested.mnemonic).toBe(REDACTED);
    expect(details.nested.ok).toBe('visible');
    expect(details.list).toEqual([{ seed: REDACTED }, 'plain']);
    // The will's token contract address is not a secret.
    expect(details.token).toBe('CTOKEN');
    expect(details.owner).toBe('GOWNER');
  });

  it('scrubs Stellar secret seeds from arbitrary string values and error messages', () => {
    const logger = new DebugLogger(true);

    logger.logOperationBuild('checkIn', '1', { note: `signed with ${SECRET_SEED}` });
    expect(lastLog(consoleLogSpy).details.note).toBe(`signed with ${REDACTED}`);

    logger.logError('checkIn', '1', new Error(`bad key ${SECRET_SEED}`));
    const { details } = lastLog(consoleLogSpy);
    expect(details.error).toBe(`bad key ${REDACTED}`);
    expect(JSON.stringify(details)).not.toContain(SECRET_SEED);
  });

  it('does not mutate the caller-supplied details object', () => {
    const logger = new DebugLogger(true);
    const details = { secret: 'value', nested: { password: 'pw' } };

    logger.logOperationBuild('createWill', '1', details);

    expect(details).toEqual({ secret: 'value', nested: { password: 'pw' } });
  });

  it('handles circular references without throwing', () => {
    const logger = new DebugLogger(true);
    const details: Record<string, unknown> = { a: 1 };
    details.self = details;

    expect(() => logger.logOperationBuild('createWill', '1', details)).not.toThrow();
    expect(lastLog(consoleLogSpy).details.self).toBe('[Circular]');
  });

  it('extends the default list with configured redactKeys', () => {
    const logger = new DebugLogger(true, { redactKeys: ['rawXdr'] });

    logger.logOperationBuild('createWill', '1', { rawXdr: 'AAAA', secret: 's', other: 'x' });

    const { details } = lastLog(consoleLogSpy);
    expect(details.rawXdr).toBe(REDACTED);
    expect(details.secret).toBe(REDACTED);
    expect(details.other).toBe('x');
  });

  it('can replace the default list entirely', () => {
    const logger = new DebugLogger(true, {
      redactKeys: ['rawXdr'],
      replaceDefaultRedactKeys: true,
    });

    logger.logOperationBuild('createWill', '1', { rawXdr: 'AAAA', password: 'pw' });

    const { details } = lastLog(consoleLogSpy);
    expect(details.rawXdr).toBe(REDACTED);
    expect(details.password).toBe('pw');
  });

  it('logs verbatim when redaction is explicitly disabled', () => {
    const logger = new DebugLogger(true, { redact: false });

    logger.logOperationBuild('createWill', '1', { secret: 's', note: SECRET_SEED });

    const { details } = lastLog(consoleLogSpy);
    expect(details.secret).toBe('s');
    expect(details.note).toBe(SECRET_SEED);
  });

  it('exposes an immutable default redaction list', () => {
    expect(DEFAULT_REDACTED_KEYS).toContain('privateKey');
    expect(Object.isFrozen(DEFAULT_REDACTED_KEYS)).toBe(true);
  });
});
