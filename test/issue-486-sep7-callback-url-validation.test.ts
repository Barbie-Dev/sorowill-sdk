import { describe, expect, it } from 'vitest';
import { buildSep7TxUri } from '../src/sep7';

const SAMPLE_XDR =
  'AAAAAgAAAABzdW1wbGVYZHJzdHJpbmcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';

/**
 * Issue #486 — buildSep7TxUri does not validate that the callback URL uses
 * https, allowing unencrypted deeplink redirects.
 *
 * SEP-7 callback URLs travel inside a deeplink that may be opened by a mobile
 * wallet across a network boundary.  Permitting http:// URLs would expose
 * transaction data (including the XDR) to passive eavesdroppers.
 *
 * Acceptance criteria:
 * - http:// callback URLs are rejected with a clear error message.
 * - https:// callback URLs are accepted.
 * - Recognised deeplink schemes (e.g. stellar://, lobstr://) are accepted.
 */
describe('Issue #486 — buildSep7TxUri callback URL scheme validation', () => {
  // ── Rejection cases ─────────────────────────────────────────────────────

  it('throws when callback URL uses plain http://', () => {
    expect(() =>
      buildSep7TxUri(SAMPLE_XDR, {
        callbackUrl: 'http://example.com/callback',
      }),
    ).toThrow(/https?:\/\//i);
  });

  it('throws for http:// URL with path and query params', () => {
    expect(() =>
      buildSep7TxUri(SAMPLE_XDR, {
        callbackUrl: 'http://callback.example.com/sign?session=abc',
      }),
    ).toThrow(/http:\/\//i);
  });

  it('throws for HTTP:// URL (uppercase scheme)', () => {
    expect(() =>
      buildSep7TxUri(SAMPLE_XDR, {
        callbackUrl: 'HTTP://EXAMPLE.COM/callback',
      }),
    ).toThrow();
  });

  it('error message mentions https or deeplink scheme as the expected alternative', () => {
    expect(() =>
      buildSep7TxUri(SAMPLE_XDR, { callbackUrl: 'http://bad.example/cb' }),
    ).toThrow(/https/i);
  });

  // ── Acceptance cases ────────────────────────────────────────────────────

  it('accepts https:// callback URLs', () => {
    const uri = buildSep7TxUri(SAMPLE_XDR, {
      callbackUrl: 'https://example.com/callback',
    });
    expect(uri).toContain('web+stellar:tx?');
    expect(uri).toContain(encodeURIComponent('https://example.com/callback'));
  });

  it('accepts mobile deeplink scheme (stellar://)', () => {
    const uri = buildSep7TxUri(SAMPLE_XDR, {
      callbackUrl: 'stellar://sign',
    });
    expect(uri).toContain('web+stellar:tx?');
  });

  it('accepts mobile deeplink scheme (lobstr://)', () => {
    const uri = buildSep7TxUri(SAMPLE_XDR, {
      callbackUrl: 'lobstr://wallet-connect?cb=1',
    });
    expect(uri).toContain('web+stellar:tx?');
  });

  it('accepts custom app deeplink scheme', () => {
    const uri = buildSep7TxUri(SAMPLE_XDR, {
      callbackUrl: 'myapp://sep7-callback',
    });
    expect(uri).toContain('web+stellar:tx?');
  });

  it('includes optional message and networkPassphrase in the URI', () => {
    const uri = buildSep7TxUri(SAMPLE_XDR, {
      callbackUrl: 'https://example.com/cb',
      message: 'Sign the will transaction',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(uri).toContain('msg=');
    expect(uri).toContain('network_passphrase=');
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it('still rejects empty callback URL even if http check would not apply', () => {
    expect(() =>
      buildSep7TxUri(SAMPLE_XDR, { callbackUrl: '   ' }),
    ).toThrow(/required/i);
  });

  it('still rejects empty XDR', () => {
    expect(() =>
      buildSep7TxUri('   ', { callbackUrl: 'https://example.com/cb' }),
    ).toThrow(/required/i);
  });
});
