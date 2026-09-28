export type {
  SignTransactionOptions,
  WalletAdapter,
  WalletConnection,
} from '../wallet';

/**
 * Response returned by WalletConnect's signTransaction method.
 *
 * WalletConnect returns a `SignedTransaction` object rather than a raw
 * string, so callers must extract `envelope_xdr` before passing the result
 * to downstream serialization logic.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
}

/**
 * Type guard that validates an unknown value is a {@link SignatureResponse}.
 *
 * Guards against the SDK treating the WalletConnect object response as a
 * string, which previously caused a cast error during serialization.
 */
export function isSignatureResponse(value: unknown): value is SignatureResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  if (typeof candidate.envelope_xdr !== 'string') {
    return false;
  }

  if (candidate.hash !== undefined && typeof candidate.hash !== 'string') {
    return false;
  }

  return true;
}

/**
 * Normalizes a WalletConnect signTransaction response into the envelope XDR
 * string expected by the SDK's TransactionSigner.
 *
 * Accepts either a raw string (already an envelope XDR) or a
 * {@link SignatureResponse} object, extracting `envelope_xdr` from the
 * latter. Throws when the response shape is invalid.
 */
export function extractEnvelopeXdr(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (isSignatureResponse(response)) {
    return response.envelope_xdr;
  }

  throw new TypeError(
    'Invalid WalletConnect signTransaction response: expected a string or a SignatureResponse object with an envelope_xdr string',
  );
}
