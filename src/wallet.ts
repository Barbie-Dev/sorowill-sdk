import type FreighterApi from '@stellar/freighter-api';

import { FreighterInstallCheckError, SignTransactionTimeoutError, WalletNetworkMismatchError } from './errors';

export class WalletSessionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause ? { cause } : undefined);
    this.name = 'WalletSessionError';
  }
}

/**
 * Union of the typed errors a {@link WalletAdapter} implementation — or the
 * SDK itself on the adapter's behalf — can raise (#524).
 *
 * Every adapter method documents which of these it may throw. Adapters may
 * additionally throw a plain `Error` carrying a wallet-reported message (for
 * example, "user rejected the request"), since third-party wallet libraries
 * surface their failures that way; use the type guards below to distinguish
 * the SDK-typed errors from such wallet-reported failures.
 *
 * Transport-specific adapters may raise additional errors (e.g.
 * `WalletConnectTimeoutError` from the WalletConnect transport); those are
 * documented on the respective adapter classes.
 */
export type WalletAdapterError =
  /** Session token could not be read, refreshed, or is still invalid. */
  | WalletSessionError
  /** The wallet's `signTransaction` did not resolve within the allowed time. */
  | SignTransactionTimeoutError
  /** The wallet is connected to a different network than the client expects. */
  | WalletNetworkMismatchError
  /** Freighter's presence could not be determined due to an internal error. */
  | FreighterInstallCheckError;

/** Type guard for {@link WalletSessionError}. */
export function isWalletSessionError(error: unknown): error is WalletSessionError {
  return error instanceof WalletSessionError;
}

/** Type guard for {@link SignTransactionTimeoutError}. */
export function isSignTransactionTimeoutError(
  error: unknown,
): error is SignTransactionTimeoutError {
  return error instanceof SignTransactionTimeoutError;
}

/** Type guard for {@link WalletNetworkMismatchError}. */
export function isWalletNetworkMismatchError(
  error: unknown,
): error is WalletNetworkMismatchError {
  return error instanceof WalletNetworkMismatchError;
}

/** Type guard for {@link FreighterInstallCheckError}. */
export function isFreighterInstallCheckError(
  error: unknown,
): error is FreighterInstallCheckError {
  return error instanceof FreighterInstallCheckError;
}

/**
 * Represents a wallet session token used for transaction signing.
 */
export interface WalletSession {
  token: string;
  expiresAt?: number;
}

/** Default session token TTL in milliseconds (15 minutes). */
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;

/**
 * `@stellar/freighter-api` is an optional peer dependency — consumers who
 * only use Albedo, Ledger, WalletConnect, or a custom {@link WalletAdapter}
 * are not required to install it. Importing it lazily (only when a
 * `FreighterWalletAdapter` method actually runs) keeps the SDK's main entry
 * point importable without it installed.
 */
let freighterApiPromise: Promise<typeof FreighterApi> | undefined;
function loadFreighterApi(): Promise<typeof FreighterApi> {
  if (!freighterApiPromise) {
    freighterApiPromise = import('@stellar/freighter-api').then((mod) => mod.default);
  }
  return freighterApiPromise;
}

/** Default timeout (ms) for a wallet signTransaction call. */
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

/**
 * Minimum Freighter extension version required by this SDK.
 *
 * Freighter versions below this may not support the APIs used by
 * {@link FreighterWalletAdapter} (e.g. `requestAccess`, `getNetworkDetails`,
 * `getAddress`, `signTransaction`). Consumers should ensure users update
 * Freighter before attempting to connect.
 */
export const MIN_FREIGHTER_VERSION = '6.0.0';

/**
 * Compares two semantic version strings (e.g. `6.0.0`, `6.1.2`).
 * Returns `true` if `a` is greater than or equal to `b`.
 */
function gteVersion(a: string, b: string): boolean {
  const parse = (v: string): number[] =>
    v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

/**
 * The `code` Freighter's `isConnected()` API returns for the ordinary
 * "extension not present/injected" case (e.g. running outside a browser, or
 * no Freighter extension installed) — as opposed to an unexpected internal
 * Freighter error, which should surface instead of being treated as "not
 * installed".
 */
const FREIGHTER_NOT_INSTALLED_CODE = -1;

/**
 * The object shape some wallets (notably WalletConnect) return from
 * `signTransaction` instead of a bare XDR string. The signed envelope is
 * carried in `envelope_xdr`; `hash` is optional metadata.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
}

/**
 * Normalizes a wallet signer result to the signed XDR string the SDK expects.
 *
 * Some adapters return a bare XDR string, while others (WalletConnect, xBull,
 * …) return a {@link SignatureResponse} object. Passing the object through as
 * if it were a string silently fails downstream, so we validate the shape here
 * and throw a clear error for anything malformed.
 */
export function normalizeSignatureResponse(
  result: string | SignatureResponse,
): string {
  if (typeof result === 'string') {
    if (result.length === 0) {
      throw new Error('Wallet signer returned an empty signed XDR string.');
    }
    return result;
  }

  if (result && typeof result === 'object') {
    const { envelope_xdr } = result as SignatureResponse;
    if (typeof envelope_xdr === 'string' && envelope_xdr.length > 0) {
      return envelope_xdr;
    }
    throw new Error(
      'Wallet signer returned a SignatureResponse without a valid `envelope_xdr` string.',
    );
  }

  throw new Error(
    `Wallet signer returned an unexpected value of type ${typeof result}; expected a signed XDR string or a SignatureResponse object.`,
  );
}

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

/**
 * Validates a wallet `signTransaction` response and normalizes it to the
 * signed envelope XDR string the SDK expects.
 *
 * Wallets are inconsistent here: some return a plain XDR string, while
 * others (e.g. WalletConnect) return a {@link SignatureResponse} object.
 * Passing the object straight through to serialization code that expects a
 * string causes a cast error, so we validate and extract `envelope_xdr`.
 *
 * @throws {Error} if the response is neither a non-empty string nor a valid
 *   {@link SignatureResponse} object.
 */
export function extractSignedEnvelopeXdr(response: unknown): string {
  if (typeof response === 'string') {
    if (response.length === 0) {
      throw new Error('Wallet returned an empty signed transaction XDR.');
    }
    return response;
  }

  if (response !== null && typeof response === 'object') {
    const { envelope_xdr } = response as Partial<SignatureResponse>;
    if (typeof envelope_xdr === 'string' && envelope_xdr.length > 0) {
      return envelope_xdr;
    }
  }

  throw new Error(
    'Wallet returned an invalid signTransaction response: expected a signed XDR string or a SignatureResponse object with an `envelope_xdr` string.',
  );
}

/** Options passed to {@link WalletAdapter.signTransaction}. */
export interface SignTransactionOptions {
  networkPassphrase: string;
  timeoutMs?: number;
}

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * ### Error contract (#524)
 *
 * Methods document the typed errors they may raise via `@throws`, all of
 * which are members of the {@link WalletAdapterError} union. Use the
 * accompanying type guards (`isWalletSessionError`,
 * `isSignTransactionTimeoutError`, `isWalletNetworkMismatchError`,
 * `isFreighterInstallCheckError`) to narrow an unknown failure. Adapters may
 * additionally reject with a plain `Error` whose message comes from the
 * wallet itself (e.g. the user dismissed the approval prompt).
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. The module-level
 * {@link getPublicKey} and {@link signTransaction} functions already satisfy
 * it (see {@link freighterAdapter}).
 *
 * ### Browser wallets
 *
 * Browser-extension adapters (Freighter, Albedo, …) implement this interface
 * and present a user-facing approval prompt when `signTransaction` is called.
 * These are the right choice for any application that handles real end-user
 * funds in a browser context.
 *
 * ### Scripts, automation, and testing — `KeypairSigner`
 *
 * For Node.js scripts, keeper bots, demo scripts, or unit tests where there is
 * no browser extension available, build a lightweight adapter on top of
 * `@stellar/stellar-sdk`'s `Keypair`:
 *
 * ```ts
 * import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
 * import type { WalletAdapter } from '@sorowill/sdk';
 *
 * export class KeypairSigner implements WalletAdapter {
 *   constructor(private readonly keypair: Keypair) {}
 *
 *   async getPublicKey(): Promise<string> {
 *     return this.keypair.publicKey();
 *   }
 *
 *   async signTransaction(
 *     transactionXdr: string,
 *     opts: { networkPassphrase: string },
 *   ): Promise<string> {
 *     const tx = TransactionBuilder.fromXDR(
 *       transactionXdr,
 *       opts.networkPassphrase,
 *     ) as Transaction;
 *     tx.sign(this.keypair);
 *     return tx.toXDR();
 *   }
 * }
 * ```
 *
 * Pass it to the client via the `wallet` option:
 *
 * ```ts
 * const signer = new KeypairSigner(Keypair.fromSecret('S...'));
 * const client = new SoroWillClient({ network: 'testnet', contractId: 'C...', wallet: signer });
 * ```
 *
 * > **Security warning:** `KeypairSigner` holds a raw secret key in memory.
 * > It is intended for scripts, automation, and testing only — never use it
 * > to handle real end-user funds in a browser or any environment where the
 * > secret could be exposed to untrusted code.
 */
export interface WalletAdapter {
  /**
   * Reports whether the wallet is currently connected.
   *
   * @throws {FreighterInstallCheckError} When the wallet's presence cannot be
   *   determined due to an internal error (Freighter only; other adapters may
   *   throw a plain `Error` instead).
   */
  isConnected(): Promise<boolean>;
  /**
   * Prompts the user (if required) and establishes a connection.
   *
   * @throws {WalletNetworkMismatchError} When the wallet is connected to a
   *   network that differs from the client's expected network passphrase.
   * @throws {Error} When the user rejects the connection or the wallet reports
   *   an internal failure.
   */
  connect(): Promise<WalletConnection>;
  /**
   * Re-establishes a previous connection without re-prompting the user where
   * possible.
   *
   * @throws {WalletNetworkMismatchError} When the wallet is connected to a
   *   network that differs from the client's expected network passphrase.
   * @throws {Error} When reconnection fails or the session can no longer be
   *   restored.
   */
  reconnect(): Promise<WalletConnection>;
  /**
   * Tears down the current connection and clears any local session state.
   *
   * @throws {Error} When the wallet reports a failure while disconnecting.
   */
  disconnect(): Promise<void>;
  /**
   * Returns the public key of the currently connected account.
   *
   * @throws {Error} When no account is connected or the wallet reports an
   *   internal failure.
   */
  getPublicKey(): Promise<string>;
  /**
   * Signs a transaction envelope, returning either the signed XDR string or a
   * {@link SignatureResponse} object carrying `envelope_xdr`.
   *
   * @throws {SignTransactionTimeoutError} When the wallet does not respond
   *   within `opts.timeoutMs` (e.g. a dismissed or hung approval popup).
   * @throws {WalletSessionError} When the adapter issues session tokens and
   *   the current token is expired and cannot be refreshed.
   * @throws {Error} When the wallet rejects the request (e.g. the user
   *   declined to sign) or returns a malformed response.
   */
  signTransaction(
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<string | SignatureResponse>;
  /**
   * Reports the network this wallet is currently set to, without prompting the user. Optional — not every wallet adapter can report this.
   *
   * @throws {Error} When the wallet cannot report its current network.
   */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
  /**
   * Returns the current session token for this wallet, if the adapter issues
   * one. Optional — adapters that do not use session tokens may omit it.
   *
   * @throws {WalletSessionError} When the session cannot be read.
   */
  getSession?(): Promise<WalletSession | undefined>;
  /**
   * Refreshes an expired/invalid session token and returns the new one.
   * Optional — only meaningful for adapters that issue session tokens.
   *
   * @throws {WalletSessionError} When the session cannot be refreshed or the
   *   refreshed token is still invalid.
   */
  refreshSession?(): Promise<WalletSession>;
}

/**
 * Validates a wallet session token before it is sent to the contract,
 * refreshing it when it is missing or expired.
 *
 * Returns the token to use, or `undefined` when the adapter does not use
 * session tokens. Throws a {@link WalletSessionError} with an actionable
 * message when the token is expired and cannot be refreshed, so callers get a
 * clear failure instead of the contract silently rejecting a stale token.
 */
export async function ensureValidSession(
  wallet: WalletAdapter,
  now: number = Date.now(),
): Promise<string | undefined> {
  if (!wallet.getSession) {
    return undefined;
  }

  let session: WalletSession | undefined;
  try {
    session = await wallet.getSession();
  } catch (err) {
    throw new WalletSessionError(
      'Failed to read the wallet session token. Reconnect the wallet and try again.',
      err,
    );
  }

  if (session && session.token && session.expiresAt !== undefined && session.expiresAt > now) {
    return session.token;
  }

  if (!wallet.refreshSession) {
    throw new WalletSessionError(
      'The wallet session token has expired and this adapter cannot refresh it. Reconnect the wallet and try again.',
    );
  }

  let refreshed: WalletSession;
  try {
    refreshed = await wallet.refreshSession();
  } catch (err) {
    throw new WalletSessionError(
      'The wallet session token expired and could not be refreshed. Reconnect the wallet and try again.',
      err,
    );
  }

  if (!refreshed || !refreshed.token || refreshed.expiresAt === undefined || refreshed.expiresAt <= now) {
    throw new WalletSessionError(
      'The wallet session token is still invalid after refreshing. Reconnect the wallet and try again.',
    );
  }

  return refreshed.token;
}

/**
 * Options for configuring a wallet session.
 *
 * `sessionTtlMs` overrides the default session token TTL (15 minutes).
 * When omitted, {@link DEFAULT_SESSION_TTL_MS} is used.
 */
export interface WalletSessionOptions {
  sessionTtlMs?: number;
}

/**
 * Options accepted by {@link FreighterWalletAdapter}.
 *
 * `expectedNetworkPassphrase` is the network the SDK/client is configured for.
 * When provided, the adapter verifies the wallet's current network against it
 * on `connect()`/`reconnect()` and rejects with a
 * {@link WalletNetworkMismatchError} on mismatch — instead of letting a
 * testnet wallet silently sign for a mainnet-configured client.
 *
 * `sessionTtlMs` overrides the default session token TTL (15 minutes).
 */
export interface FreighterWalletAdapterOptions extends WalletSessionOptions {
  expectedNetworkPassphrase?: string;
}

/**
 * Browser-extension wallet adapter backed by the Freighter browser extension.
 *
 * ## Minimum Freighter version
 *
 * This adapter requires Freighter {@link MIN_FREIGHTER_VERSION} or later.
 * Older versions may not support the `@stellar/freighter-api` methods used
 * here (`requestAccess`, `getNetworkDetails`, `getAddress`, `signTransaction`).
 * The version is checked on {@link connect} and an error is thrown if the
 * installed Freighter is below the minimum.
 *
 * @since 0.1.0
 */
export class FreighterWalletAdapter implements WalletAdapter {
  private readonly expectedNetworkPassphrase?: string;
  private readonly sessionTtlMs: number;
  private session?: WalletSession;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    if (options.expectedNetworkPassphrase !== undefined) {
      this.expectedNetworkPassphrase = options.expectedNetworkPassphrase;
    }
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  /**
   * Rejects with a {@link WalletNetworkMismatchError} when the wallet's
   * reported network passphrase does not match the configured one. No-op when
   * no expected passphrase was configured or the wallet reports none.
   */
  private assertNetworkMatches(networkPassphrase: string): void {
    if (!this.expectedNetworkPassphrase || !networkPassphrase) {
      return;
    }
    if (networkPassphrase !== this.expectedNetworkPassphrase) {
      throw new WalletNetworkMismatchError(this.expectedNetworkPassphrase, networkPassphrase);
    }
  }

  /**
   * Asserts that the installed Freighter extension meets the minimum version
   * requirement ({@link MIN_FREIGHTER_VERSION}).
   *
   * Attempts to read the Freighter API version from the loaded
   * `@stellar/freighter-api` module. If the version cannot be determined or
   * is below the minimum, throws a {@link FreighterInstallCheckError}.
   */
  private async assertFreighterVersion(): Promise<void> {
    try {
      const freighterApi = await loadFreighterApi();
      const version =
        (freighterApi as unknown as { version?: string }).version ??
        (freighterApi as unknown as { default?: { version?: string } }).default
          ?.version;
      if (version && !gteVersion(version, MIN_FREIGHTER_VERSION)) {
        throw new FreighterInstallCheckError(
          -1,
          `Freighter version ${version} is below the minimum required version ${MIN_FREIGHTER_VERSION}. Please update Freighter.`,
        );
      }
    } catch (err) {
      if (err instanceof FreighterInstallCheckError) {
        throw err;
      }
      // If we cannot determine the version, warn but do not block — the
      // extension may still work even if its version is not exposed.
      console.warn(
        `[SoroWill] Could not determine Freighter version; proceeding without version check. ` +
          `Ensure Freighter is at least v${MIN_FREIGHTER_VERSION}.`,
      );
    }
  }

  /**
   * Reports whether the Freighter extension is present and reachable.
   *
   * Resolves `false` only for the ordinary "extension not installed/injected"
   * case. Any other error Freighter's `isConnected()` API reports (e.g. it
   * was called outside a browser, or Freighter hit an internal error) is
   * surfaced as a thrown {@link FreighterInstallCheckError} instead of being
   * silently treated as "not installed".
   */
  async isConnected(): Promise<boolean> {
    const freighterApi = await loadFreighterApi();
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      if (error.code === FREIGHTER_NOT_INSTALLED_CODE) {
        return false;
      }
      throw new FreighterInstallCheckError(error.code, error.message);
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    await this.assertFreighterVersion();
    const freighterApi = await loadFreighterApi();
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    const networkPassphrase = networkDetails?.networkPassphrase ?? '';
    this.assertNetworkMatches(networkPassphrase);

    return {
      publicKey: access.address,
      network: networkDetails?.network ?? '',
      networkPassphrase,
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const freighterApi = await loadFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }

    const networkPassphrase = networkDetails?.networkPassphrase ?? '';
    this.assertNetworkMatches(networkPassphrase);

    return {
      publicKey,
      network: networkDetails?.network ?? '',
      networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    delete (this as unknown as Record<string, unknown>).session;
    return;
  }

  /** Reports the network Freighter is currently set to, without prompting the user. */
  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const freighterApi = await loadFreighterApi();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails?.error) {
      throw new Error(networkDetails.error.message);
    }
    return {
      network: networkDetails?.network ?? '',
      networkPassphrase: networkDetails?.networkPassphrase ?? '',
    };
  }

  async getPublicKey(): Promise<string> {
    const freighterApi = await loadFreighterApi();
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
  }

  /** Returns the current session token, if one has been established. */
  async getSession(): Promise<WalletSession | undefined> {
    return this.session;
  }

  /**
   * Refreshes the session token by re-reading the connected account from
   * Freighter and issuing a fresh token with a new expiry.
   */
  async refreshSession(): Promise<WalletSession> {
    const publicKey = await this.getPublicKey();
    this.session = {
      token: publicKey,
      expiresAt: Date.now() + this.sessionTtlMs,
    };
    return this.session;
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string; timeoutMs?: number },
  ): Promise<string> {
    // Validate/refresh the session token before handing anything to the
    // contract, so an expired token surfaces a clear error here instead of
    // being rejected opaquely on-chain.
    await ensureValidSession(this);

    const timeoutMs = opts.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;
    // Kicked off synchronously (not awaited yet) so the timeout below is
    // still registered before this function's first `await`, regardless of
    // how long the dynamic import takes to resolve.
    const freighterApiPromise = loadFreighterApi();

    // Race the Freighter call against a timer so that a hung or dismissed
    // popup never leaves the caller's promise pending
    const result = await Promise.race<unknown>([
      freighterApiPromise.then((freighterApi) =>
        freighterApi.signTransaction(transactionXdr, {
          networkPassphrase: opts.networkPassphrase,
        }),
      ),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new SignTransactionTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);

    if (result && typeof result === 'object' && 'error' in result && result.error) {
      const errorMessage = typeof result.error === 'object' && result.error !== null && 'message' in result.error
        ? String((result.error as Record<string, unknown>).message)
        : String(result.error);
      throw new Error(errorMessage);
    }

    // Freighter returns a bare XDR string, but normalize defensively so any
    // wallet that returns a SignatureResponse object is handled uniformly.
    return extractSignedEnvelopeXdr(result);
  }
}

/**
 * WalletConnect-backed wallet adapter.
 *
 * WalletConnect's `signTransaction` returns a {@link SignatureResponse}
 * object (`{ envelope_xdr, hash }`) rather than a bare XDR string. This
 * adapter validates that response and extracts `envelope_xdr` so downstream
 * serialization receives the string it expects.
 */
export class WalletConnectWalletAdapter implements WalletAdapter {
  constructor(
    private readonly connector: {
      isConnected(): Promise<boolean>;
      connect(): Promise<WalletConnection>;
      reconnect(): Promise<WalletConnection>;
      disconnect(): Promise<void>;
      getPublicKey(): Promise<string>;
      signTransaction(
        transactionXdr: string,
        opts: SignTransactionOptions,
      ): Promise<string | SignatureResponse>;
      getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
    },
  ) {}

  isConnected(): Promise<boolean> {
    return this.connector.isConnected();
  }

  connect(): Promise<WalletConnection> {
    return this.connector.connect();
  }

  reconnect(): Promise<WalletConnection> {
    return this.connector.reconnect();
  }

  disconnect(): Promise<void> {
    return this.connector.disconnect();
  }

  getPublicKey(): Promise<string> {
    return this.connector.getPublicKey();
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string | SignatureResponse> {
    return this.connector.signTransaction(transactionXdr, options);
  }
}

const defaultFreighterWalletAdapter = new FreighterWalletAdapter();

/**
 * The default {@link WalletAdapter}, backed by the Freighter browser
 * extension. This is what {@link SoroWillClient} uses when no `wallet` option
 * is supplied, so existing Freighter-based usage keeps working unchanged.
 */
export const freighterAdapter: WalletAdapter = {
  isConnected: () => defaultFreighterWalletAdapter.isConnected(),
  connect: () => defaultFreighterWalletAdapter.connect(),
  reconnect: () => defaultFreighterWalletAdapter.reconnect(),
  disconnect: () => defaultFreighterWalletAdapter.disconnect(),
  getPublicKey: () => defaultFreighterWalletAdapter.getPublicKey(),
  signTransaction: (xdr: string, opts: SignTransactionOptions) => defaultFreighterWalletAdapter.signTransaction(xdr, opts),
  getNetwork: () => defaultFreighterWalletAdapter.getNetwork(),
};

export function getDefaultWalletAdapter(): WalletAdapter {
  return freighterAdapter;
}

export async function getPublicKey(): Promise<string> {
  return defaultFreighterWalletAdapter.getPublicKey();
}

export async function signTransaction(xdr: string, opts: SignTransactionOptions): Promise<string> {
  return defaultFreighterWalletAdapter.signTransaction(xdr, opts);
}

export async function isFreighterInstalled(): Promise<boolean> {
  try {
    const freighterApi = await loadFreighterApi();
    const { isConnected, error } = await freighterApi.isConnected();
    if (error && error.code === FREIGHTER_NOT_INSTALLED_CODE) {
      return false;
    }
    return isConnected && !error;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<WalletConnection> {
  return defaultFreighterWalletAdapter.connect();
}
