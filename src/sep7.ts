import { xdr } from '@stellar/stellar-sdk';

export interface BuildSep7TxUriOptions {
  /** Absolute http(s) URL; emitted with the `url:` prefix required by SEP-0007. */
  callbackUrl: string;
  /** Message shown to the user. SEP-0007 limits it to 300 characters; longer values are rejected. */
  message?: string;
  networkPassphrase?: string;
  originDomain?: string;
}

export interface Sep7CallbackResult {
  transactionXdr: string;
  signerAddress?: string | undefined;
  status?: string | undefined;
  message?: string | undefined;
}

export interface ParseSep7CallbackOptions {
  /**
   * The transaction XDR originally sent for signing. When provided, the
   * callback's transaction must match it (signatures are ignored).
   */
  expectedTransactionXdr?: string;
}

const SEP7_MAX_MESSAGE_LENGTH = 300;
/**
 * Maximum decoded transaction-envelope size accepted by {@link buildSep7TxUri}.
 *
 * SEP-7 URIs are scanned as QR codes / opened as deeplinks, so oversized
 * envelopes fail in wallets even when the URI itself is well-formed. Stellar
 * envelopes are small (a typical payment is ~200 bytes); 1 KiB of headroom
 * keeps normal flows working while rejecting pathological payloads early
 * with a clear SDK error instead of a silent wallet failure.
 *
 * @since 0.1.2
 */
export const SEP7_MAX_ENVELOPE_BYTES = 1024;
/**
 * Maximum length (in characters) of the final `web+stellar:tx?...` URI string
 * produced by {@link buildSep7TxUri}. QR scanners, mobile deeplink handlers,
 * and browsers impose their own (much larger) limits, but a conservative cap
 * here fails fast with an actionable message.
 *
 * @since 0.1.2
 */
export const SEP7_MAX_URI_LENGTH = 2048;
const SEP7_FAILURE_STATUSES = new Set([
  'error',
  'fail',
  'failed',
  'failure',
  'reject',
  'rejected',
  'declined',
  'denied',
  'cancel',
  'canceled',
  'cancelled',
]);

function decodeEnvelope(transactionXdr: string, label: string): xdr.TransactionEnvelope {
  try {
    return xdr.TransactionEnvelope.fromXDR(transactionXdr, 'base64');
  } catch {
    throw new Error(`SEP-7 ${label} is not a valid transaction envelope XDR`);
  }
}

function transactionBodyXdr(envelope: xdr.TransactionEnvelope): string {
  return (envelope.value() as { tx(): { toXDR(format: 'base64'): string } }).tx().toXDR('base64');
}

function normalizeSep7Params(input: string | URL | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) {
    return new URLSearchParams(input);
  }

  if (input instanceof URL) {
    const raw = input.search.length > 1 ? input.search.slice(1) : input.hash.replace(/^#/, '');
    return new URLSearchParams(raw);
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return new URLSearchParams();
  }

  if (trimmed.includes('://') || trimmed.startsWith('web+stellar:')) {
    return normalizeSep7Params(new URL(trimmed));
  }

  return new URLSearchParams(trimmed.replace(/^[?#]/, ''));
}

/**
 * Builds a percent-encoded query string for a SEP-7 URI.
 *
 * `URLSearchParams.toString()` encodes spaces as `+` (application/x-www-form-urlencoded),
 * which is not valid in a URI query string. We use `encodeURIComponent` directly on
 * each key-value pair to produce proper percent-encoding (`%20` for spaces,
 * `%3A` for colons, etc.) that is unambiguous in all URI contexts and deeplink handlers.
 *
 * Additionally, the SEP-7 `callback` field requires the `url:` prefix to be
 * included in the encoded value so deeplink handlers can distinguish it from
 * a plain URL. We encode the full `url:<callbackUrl>` string as a single unit.
 */
function encodeSep7Params(params: URLSearchParams): string {
  const parts: string[] = [];
  params.forEach((value, key) => {
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  });
  return parts.join('&');
}

export function buildSep7TxUri(transactionXdr: string, options: BuildSep7TxUriOptions): string {
  if (transactionXdr.trim().length === 0) {
    throw new Error('SEP-7 transaction XDR is required');
  }

  const trimmedXdr = transactionXdr.trim();
  // Validate the decoded envelope size so oversized payloads fail fast with a
  // clear SDK error instead of producing a URI that wallets/QR scanners reject.
  // Non-base64 input is left to downstream XDR parsing; only measurable,
  // decodable envelopes are size-checked here.
  let envelopeBytes = -1;
  try {
    const decoded =
      typeof Buffer !== 'undefined'
        ? Buffer.from(trimmedXdr, 'base64')
        : Uint8Array.from(atob(trimmedXdr), (c) => c.charCodeAt(0));
    envelopeBytes = decoded.length;
  } catch {
    envelopeBytes = -1;
  }
  if (envelopeBytes >= 0 && envelopeBytes > SEP7_MAX_ENVELOPE_BYTES) {
    throw new Error(
      `SEP-7 transaction envelope is too large (${envelopeBytes} bytes exceeds the ${SEP7_MAX_ENVELOPE_BYTES}-byte limit); ` +
        'reduce the transaction size (fewer operations/memos) before building a SEP-7 URI',
    );
  }

  if (options.callbackUrl.trim().length === 0) {
    throw new Error('SEP-7 callback URL is required');
  }

  let callbackUrl: URL;
  try {
    callbackUrl = new URL(options.callbackUrl.trim());
  } catch {
    throw new Error('SEP-7 callback URL must be an absolute https:// URL or a valid deeplink scheme');
  }

  // Reject http (insecure), data, javascript, and other unsafe schemes
  if (callbackUrl.protocol === 'http:') {
    throw new Error('SEP-7 callback URL cannot use http:// (insecure); use https:// or a deeplink scheme like stellar://');
  }

  // Allow https and common deeplink schemes (stellar, lobstr, myapp, etc)
  const isHttps = callbackUrl.protocol === 'https:';
  const isDeeplink = /^[a-z][a-z0-9+.-]*:$/i.test(callbackUrl.protocol) &&
                     callbackUrl.protocol !== 'http:' &&
                     callbackUrl.protocol !== 'data:' &&
                     callbackUrl.protocol !== 'javascript:' &&
                     callbackUrl.protocol !== 'file:' &&
                     callbackUrl.protocol !== 'ftp:';

  if (!isHttps && !isDeeplink) {
    throw new Error('SEP-7 callback URL must be an absolute https:// URL or a valid deeplink scheme');
  }

  if (options.message && options.message.length > SEP7_MAX_MESSAGE_LENGTH) {
    throw new Error(`SEP-7 message must be at most ${SEP7_MAX_MESSAGE_LENGTH} characters`);
  }

  const params = new URLSearchParams({
    xdr: transactionXdr,
    callback: `url:${options.callbackUrl.trim()}`,
  });

  if (options.message) {
    params.set('msg', options.message);
  }

  if (options.networkPassphrase) {
    params.set('network_passphrase', options.networkPassphrase);
  }

  if (options.originDomain) {
    params.set('origin_domain', options.originDomain);
  }

  const uri = `web+stellar:tx?${encodeSep7Params(params)}`;
  if (uri.length > SEP7_MAX_URI_LENGTH) {
    throw new Error(
      `SEP-7 URI is too large (${uri.length} characters exceeds the ${SEP7_MAX_URI_LENGTH}-character limit); ` +
        'reduce the transaction envelope size or shorten optional fields (message, callback URL) before building a SEP-7 URI',
    );
  }
  return uri;
}

export function parseSep7Callback(
  input: string | URL | URLSearchParams,
  options: ParseSep7CallbackOptions = {},
): Sep7CallbackResult {
  const params = normalizeSep7Params(input);
  const transactionXdrValue =
    params.get('xdr') ??
    params.get('signedTxXdr') ??
    params.get('signed_tx_xdr') ??
    params.get('envelope_xdr') ??
    params.get('tx');

  if (!transactionXdrValue) {
    throw new Error('SEP-7 callback did not include a signed transaction XDR');
  }

  const transactionXdr = transactionXdrValue;
  const signerAddressValue = params.get('pubkey') ?? params.get('signer');
  const signerAddress: string | undefined = signerAddressValue ?? undefined;
  const status: string | undefined = params.get('status') ?? undefined;
  const message: string | undefined = params.get('message') ?? params.get('msg') ?? undefined;

  if (status !== undefined && SEP7_FAILURE_STATUSES.has(status.trim().toLowerCase())) {
    throw new Error(`SEP-7 callback reported status "${status}"${message ? `: ${message}` : ''}`);
  }

  const envelope = decodeEnvelope(transactionXdr, 'callback transaction');
  if (options.expectedTransactionXdr !== undefined) {
    const expected = decodeEnvelope(options.expectedTransactionXdr, 'expected transaction');
    if (transactionBodyXdr(envelope) !== transactionBodyXdr(expected)) {
      throw new Error('SEP-7 callback transaction does not match the requested transaction');
    }
  }

  const result: Sep7CallbackResult = { transactionXdr };
  if (signerAddress !== undefined) result.signerAddress = signerAddress;
  if (status !== undefined) result.status = status;
  if (message !== undefined) result.message = message;
  return result;
}
