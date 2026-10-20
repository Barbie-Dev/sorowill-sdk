import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugLogger } from '../src/debugLogger';

// Since #576 redaction is on by default; these tests cover the explicit
// `redact: false` opt-out, which still logs caller-supplied details verbatim.
describe('Issue #212: DebugLogger logs caller-supplied details verbatim when redaction is disabled', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let logger: DebugLogger;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger = new DebugLogger(true, { redact: false });
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('should log caller-supplied details verbatim without filtering or redaction', () => {
    const sensitiveDetails = {
      rawXdr: 'SECRET_XDR_DATA_HERE',
      rpcErrorBody: { internalDetails: 'INTERNAL_ERROR', apiKey: 'HIDDEN_KEY' },
      userAddress: 'GUSER123456789',
    };

    logger.logOperationBuild('test_method', 'will_123', sensitiveDetails);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const loggedJson = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);

    expect(parsed.details).toEqual(sensitiveDetails);
  });

  it('should log error messages from caller verbatim including sensitive data', () => {
    const errorWithSensitiveInfo = new Error('Failed with RPC response: {"error":"XDR=ABC123DEF456"}');

    logger.logError('test_method', 'will_456', errorWithSensitiveInfo);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const loggedJson = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);

    expect(parsed.details.error).toContain('XDR=ABC123DEF456');
  });

  it('should include all caller-supplied fields without any filtering or allowlisting', () => {
    const detailsWithMultipleFields = {
      field1: 'value1',
      sensitiveField: 'SENSITIVE_DATA',
      nestedSecret: { key: 'SECRET_VALUE', nested: { deep: 'DEEP_SECRET' } },
      listOfSecrets: ['SECRET1', 'SECRET2', 'SECRET3'],
      apiKey: 'SHOULD_BE_VISIBLE',
      token: 'SHOULD_BE_VISIBLE',
    };

    logger.logOperationBuild('test_method', 'will_789', detailsWithMultipleFields);

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const secondCall = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(secondCall);

    expect(parsed.details.sensitiveField).toBe('SENSITIVE_DATA');
    expect(parsed.details.nestedSecret.key).toBe('SECRET_VALUE');
    expect(parsed.details.nestedSecret.nested.deep).toBe('DEEP_SECRET');
    expect(parsed.details.listOfSecrets).toEqual(['SECRET1', 'SECRET2', 'SECRET3']);
    expect(parsed.details.apiKey).toBe('SHOULD_BE_VISIBLE');
  });

  it('should document that there is no validation or redaction of caller-supplied details', () => {
    expect(() => {
      logger.logOperationBuild('test', 'will_123', {
        apiKeys: 'UNFILTERED_API_KEYS',
        passwords: 'UNFILTERED_PASSWORDS',
        secrets: 'UNFILTERED_SECRETS',
        privateData: 'UNFILTERED_PRIVATE_DATA',
      });
    }).not.toThrow();

    expect(consoleLogSpy).toHaveBeenCalled();
  });

  it('should log XDR and RPC responses verbatim as caller provides them', () => {
    const rpcErrorWithInternals = {
      xdrEnvelope: 'AAAA...ZZZZ',
      rpcError: 'InternalServerError: Database connection failed',
      internalDetails: 'Connection refused to 10.0.0.5:5432',
    };

    logger.logSimulation('test_method', 'will_555', '5000', rpcErrorWithInternals);

    expect(consoleLogSpy).toHaveBeenCalled();
    const loggedJson = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);

    expect(parsed.details.xdrEnvelope).toBe('AAAA...ZZZZ');
    expect(parsed.details.internalDetails).toBe('Connection refused to 10.0.0.5:5432');
  });

  it('should log error objects with message including caller-supplied sensitive data', () => {
    const error = new Error('Wallet signature error: private_key_exposure=true');

    logger.logError('checkIn', 'will_999', error);

    expect(consoleLogSpy).toHaveBeenCalled();
    const loggedJson = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);

    expect(parsed.details.error).toContain('private_key_exposure=true');
  });

  it('should demonstrate that callers are fully responsible for not passing secrets', () => {
    const callersDetailsThatContainSecrets = {
      operation: 'sign_transaction',
      signerPrivateKey: 'SAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      destinationAddress: 'GXXXXX',
      secret: 'super_secret_value_123',
    };

    logger.logOperationBuild('secure_operation', 'will_111', callersDetailsThatContainSecrets);

    const loggedJson = consoleLogSpy.mock.calls[0][0];
    const parsed = JSON.parse(loggedJson);

    expect(parsed.details.signerPrivateKey).toBe('SAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    expect(parsed.details.secret).toBe('super_secret_value_123');
  });
});
