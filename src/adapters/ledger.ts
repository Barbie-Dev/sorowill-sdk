import type Str from '@ledgerhq/hw-app-str';
import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

import { SignTransactionTimeoutError, WalletNetworkMismatchError } from '../errors';

import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

/** Default timeout (ms) for a Ledger signTransaction call. */
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;

/**
 * `@ledgerhq/hw-app-str` is an optional peer dependency — consumers who only
 * use Freighter, Albedo, WalletConnect, or a custom {@link WalletAdapter} are
 * not required to install it, so it must be imported lazily rather than at
 * module load time.
 */
let strCtorPromise: Promise<typeof Str> | undefined;
function loadStrCtor(): Promise<typeof Str> {
  if (!strCtorPromise) {
    strCtorPromise = import('@ledgerhq/hw-app-str').then((mod) => mod.default);
  }
  return strCtorPromise;
}

export interface LedgerTransport {
  close?(): Promise<void>;
}

export interface LedgerStellarApp {
  getPublicKey(path: string, display?: boolean): Promise<{ rawPublicKey: Buffer }>;
  signTransaction(path: string, signatureBase: Buffer): Promise<{ signature: Buffer }>;
}

export interface LedgerWalletAdapterOptions {
  transport: LedgerTransport;
  /** Stellar BIP-44 account path. */
  derivationPath?: string;
  network?: string;
  networkPassphrase: string;
  /**
   * Milliseconds to wait for the on-device confirmation before rejecting with
   * {@link SignTransactionTimeoutError}. Defaults to 120000. The Ledger promise
   * stays pending until the user physically approves or rejects on the device,
   * so a host that sets this should also surface a "waiting for device
   * confirmation — cancel?" affordance while the call is in flight.
   */
  timeoutMs?: number;
  /** Test seam for a mocked Ledger Stellar application. */
  app?: LedgerStellarApp;
}

/**
 * Wallet adapter backed by the Ledger Stellar device application.
 *
 * ## Network behavior
 *
 * - The adapter reports the `networkPassphrase` (and optional `network`)
 *   supplied in `LedgerWalletAdapterOptions`; it does not query the device for
 *   the network. The same derivation path (`44'/148'/0'` by default) is used
 *   on both testnet and mainnet, so the same Ledger account can interoperate
 *   with either network — but you must tell the adapter which one.
 * - `signTransaction` rejects with {@link WalletNetworkMismatchError} if the
 *   `networkPassphrase` on a signing call differs from the adapter's
 *   configured passphrase, preventing signatures valid on the wrong network.
 *
 * ## Known issues
 *
 * - Ledger does not report the network it is configured for, so the SDK has no
 *   way to detect that a user's Ledger is set to mainnet while the app targets
 *   testnet (or vice versa) beyond the passphrase you configure. A mismatch
 *   only surfaces when the client's `assertWalletNetwork` compares passphrases.
 * - The on-device confirmation prompt can take longer than the default
 *   timeout; set `timeoutMs` higher for mainnet congestion or slow users.
 *
 * ## Workarounds
 *
 * - Construct the adapter with the `networkPassphrase` matching your
 *   `SoroWillClient.network` and call
 *   `client.assertWalletNetwork({ networkPassphrase })` after connecting
 *   before submitting any transaction.
 * - Increase `timeoutMs` if users regularly walk away mid-confirmation.
 */
export class LedgerWalletAdapter implements WalletAdapter {
  readonly id = 'ledger';
  readonly name = 'Ledger';

  private appPromise: Promise<LedgerStellarApp> | undefined;
  private readonly derivationPath: string;
  private publicKey: string | null = null;

  constructor(private readonly options: LedgerWalletAdapterOptions) {
    this.derivationPath = options.derivationPath ?? "44'/148'/0'";
  }

  private async getApp(): Promise<LedgerStellarApp> {
    if (this.options.app) {
      return this.options.app;
    }
    if (!this.appPromise) {
      this.appPromise = loadStrCtor().then(
        (StrCtor) =>
          new StrCtor(this.options.transport as unknown as ConstructorParameters<typeof Str>[0]),
      );
    }
    return this.appPromise;
  }

  async connect(): Promise<WalletConnection> {
    const app = await this.getApp();
    const result = await app.getPublicKey(this.derivationPath);
    this.publicKey = StrKey.encodeEd25519PublicKey(result.rawPublicKey);
    return {
      publicKey: this.publicKey,
      network: this.options.network ?? 'custom',
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  async reconnect(): Promise<WalletConnection> {
    return this.connect();
  }

  async disconnect(): Promise<void> {
    await this.options.transport.close?.();
    this.publicKey = null;
  }

  async isConnected(): Promise<boolean> {
    return this.publicKey !== null;
  }

  async getPublicKey(): Promise<string> {
    if (!this.publicKey) {
      throw new Error('Ledger is not connected. Call connect() first.');
    }
    return this.publicKey;
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    if (options.networkPassphrase !== this.options.networkPassphrase) {
      throw new WalletNetworkMismatchError(this.options.networkPassphrase, options.networkPassphrase);
    }
    const publicKey = await this.getPublicKey();
    const app = await this.getApp();
    const transaction = TransactionBuilder.fromXDR(transactionXdr, options.networkPassphrase);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_SIGN_TIMEOUT_MS;

    // The Ledger promise remains pending while the device displays transaction
    // details and cannot resolve before physical approval. Race it against a
    // timer so a walked-away user, a mid-approval disconnect, or a confirmation
    // that never comes rejects the caller instead of hanging forever (#154).
    const signatureBase = Buffer.from(transaction.signatureBase());
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new SignTransactionTimeoutError(timeoutMs)),
        timeoutMs,
      );
    });

    try {
      const { signature } = await Promise.race([
        app.signTransaction(this.derivationPath, signatureBase),
        timeoutPromise,
      ]);
      transaction.addSignature(publicKey, signature.toString('base64'));
      return transaction.toXDR();
    } finally {
      clearTimeout(timeoutHandle!);
    }
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    return {
      network: this.options.network ?? 'custom',
      networkPassphrase: this.options.networkPassphrase,
    };
  }
}
