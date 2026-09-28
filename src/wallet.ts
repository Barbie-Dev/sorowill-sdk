import type FreighterApi from '@stellar/freighter-api';

import { FreighterInstallCheckError, SignTransactionTimeoutError, WalletNetworkMismatchError } from './errors';

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
 * The `code` Freighter's `isConnected()` API returns for the ordinary
 * "extension not present/injected" case (e.g. running outside a browser, or
 * no Freighter extension installed) — as opposed to an unexpected internal
 * Freighter error, which should surface instead of being treated as "not
 * installed".
 */
const FREIGHTER_NOT_INSTALLED_CODE = -1;

/**
 * The structured signature response some wallet adapters (WalletConnect,
 * xBull, …) return instead of a bare signed-XDR string. The SDK normalizes
 * this to the `envelope_xdr` string so callers always receive a string.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash: string;
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
 * The object shape some wallets (notably WalletConnect) return from
 * `signTransaction` instead of a bare XDR string. The signed envelope is
 * carried in `envelope_xdr`; `hash` is optional metadata.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
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

/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
 *
 * Any wallet — Freighter, Albedo, xBull, Rabet, Lobstr, etc. — can be plugged
 * into the client by implementing this interface. {@link FreighterWalletAdapter}
 * is the default implementation, backed by the Freighter browser extension.
 */
/**
 * The full capability set a Stellar wallet must expose for
 * {@link SoroWillClient} to read the connected account and sign transactions.
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
 * no browser extension available, build a lightweight adapter directly on top
 * of `@stellar/stellar-sdk`'s `Keypair`:
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
export interface SignTransactionOptions {
  networkPassphrase: string;
  timeoutMs?: number;
}

export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  reconnect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(
    transactionXdr: string,
    opts: SignTransactionOptions,
  ): Promise<string | SignatureResponse>;
  /** Reports the network this wallet is currently set to, without prompting the user. Optional — not every wallet adapter can report this. */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
  /**
   * Returns the current session token for this wallet, if the adapter issues
   * one. Optional — adapters that do not use session tokens may omit it.
   */
  getSession?(): Promise<WalletSession | undefined>;
  /**
   * Refreshes an expired/invalid session token and returns the new one.
   * Optional — only meaningful for adapters that issue session tokens.
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

  if (session && session.token && session.expiresAt > now) {
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

  if (!refreshed || !refreshed.token || refreshed.expiresAt <= now) {
    throw new WalletSessionError(
      'The wallet session token is still invalid after refreshing. Reconnect the wallet and try again.',
    );
  }

  return refreshed.token;
}

/**
 * Options accepted by {@link FreighterWalletAdapter}.
 *
 * `expectedNetworkPassphrase` is the network the SDK/client is configured for.
 * When provided, the adapter verifies the wallet's current network against it
 * on `connect()`/`reconnect()` and rejects with a
 * {@link WalletNetworkMismatchError} on mismatch — instead of letting a
 * testnet wallet silently sign for a mainnet-configured client.
 */
export interface FreighterWalletAdapterOptions {
  expectedNetworkPassphrase?: string;
}

export class FreighterWalletAdapter implements WalletAdapter {
  private readonly expectedNetworkPassphrase?: string;

  constructor(options: FreighterWalletAdapterOptions = {}) {
    this.expectedNetworkPassphrase = options.expectedNetworkPassphrase;
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
    this.session = undefined;
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
      expiresAt: Date.now() + DEFAULT_SESSION_TTL_MS,
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
    const result = await Promise.race([
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
      throw new Error(result.error.message);
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
  getPublicKey,
  signTransaction,
  getNetwork: () => defaultFreighterWalletAdapter.getNetwork(),
};
