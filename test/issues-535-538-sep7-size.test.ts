/**
 * Tests for issue #536: BuildSep7TxUriOptions lacks validation for
 * transaction envelope size.
 */
import { describe, expect, it } from 'vitest';
import { buildSep7TxUri, SEP7_MAX_ENVELOPE_BYTES, SEP7_MAX_URI_LENGTH } from '../src/sep7';
const CALLBACK = 'https://example.com/callback';
function base64OfBytes(n: number): string {
  return Buffer.from(new Uint8Array(n)).toString('base64');
}
describe('buildSep7TxUri issue 536: envelope size validation', () => {
  it('accepts a small envelope', () => {
    const uri = buildSep7TxUri('AAAAAAAA', { callbackUrl: CALLBACK });
    expect(uri.startsWith('web+stellar:tx?')).toBe(true);
  });
  it('accepts an envelope exactly at the byte limit', () => {
    const uri = buildSep7TxUri(base64OfBytes(SEP7_MAX_ENVELOPE_BYTES), { callbackUrl: CALLBACK });
    expect(uri.startsWith('web+stellar:tx?')).toBe(true);
  });
  it('rejects an envelope one byte over the limit with a clear error', () => {
    expect(() => buildSep7TxUri(base64OfBytes(SEP7_MAX_ENVELOPE_BYTES + 1), { callbackUrl: CALLBACK })).toThrow(/too large.*byte limit/);
  });
  it('rejects a final URI over the character limit with a clear error', () => {
    const longCallback = 'https://example.com/' + 'c'.repeat(SEP7_MAX_URI_LENGTH);
    expect(() => buildSep7TxUri('AAAAAAAA', { callbackUrl: longCallback })).toThrow(/URI is too large.*character limit/);
  });
});
