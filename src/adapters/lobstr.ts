import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

/** Session bridge used to pair a web application with LOBSTR mobile. */
export interface LobstrSessionClient {
  connect(): Promise<{ uri?: string; approval: () => Promise<WalletConnection> }>;
  disconnect(): Promise<void>;
  isConnected(): Promise<boolean>;
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, options: SignTransactionOptions): Promise<string>;
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

export interface LobstrWalletAdapterOptions {
  client: LobstrSessionClient;
  /** Receives the WalletConnect URI so a desktop app can display a QR code. */
  onPairingUri?: (uri: string) => void;
  /** Receives the LOBSTR deep link so the host can open it on mobile. */
  openDeepLink?: (deepLink: string) => void;
  /** LOBSTR's WalletConnect deep-link prefix. */
  deepLinkPrefix?: string;
  /** Maximum time to wait for pairing approval before rejecting. */
  approvalTimeoutMs?: number;
}

/**
 * LOBSTR mobile adapter backed by a WalletConnect-compatible session client.
 *
 * `connect()` publishes the pairing URI before awaiting approval, allowing the
 * host to render a QR code or open the corresponding LOBSTR deep link.
 *
 * ## Network behavior
 *
 * - Network reporting is delegated to the LOBSTR session client:
 *   `getNetwork()` returns whatever `client.getNetwork()` reports. If the
 *   session client does not implement `getNetwork`, `getNetwork()` throws
 *   ("LOBSTR session client does not support network detection") and the SDK
 *   cannot verify the wallet's network.
 * - LOBSTR does not let the SDK force a network: the LOBSTR app decides which
 *   network the user is on. Always confirm
 *   `SoroWillClient.assertWalletNetwork()` after connecting so the client and
 *   wallet agree on testnet vs mainnet before signing.
 *
 * ## Known issues
 *
 * - LOBSTR may be connected to mainnet while the app targets testnet (or vice
 *   versa). Without `client.getNetwork()` the SDK cannot detect this and
 *   `getNetwork()` throws; with it, a mismatch surfaces as a
 *   {@link WalletNetworkMismatchError}, not a silent wrong-network signature.
 * - Pairing requires the user to scan a QR code / open a deep link on mobile,
 *   so `connect()` can time out if the user never approves (`approvalTimeoutMs`).
 *
 * ## Workarounds
 *
 * - Ensure the session client implements `getNetwork()` and returns the
 *   network matching your deployment, then call
 *   `client.assertWalletNetwork({ networkPassphrase })` after
 *   `adapter.connect()` before submitting any transaction.
 * - Tune `approvalTimeoutMs` (default 60000ms) for slower pairing flows.
 */
export class LobstrWalletAdapter implements WalletAdapter {
  readonly id = 'lobstr';
  readonly name = 'LOBSTR';

  private readonly deepLinkPrefix: string;
  private readonly approvalTimeoutMs: number;

  constructor(private readonly options: LobstrWalletAdapterOptions) {
    this.deepLinkPrefix = options.deepLinkPrefix ?? 'lobstr://wallet-connect?uri=';
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 60_000;
  }

  async connect(): Promise<WalletConnection> {
    const pairing = await this.options.client.connect();
    if (pairing.uri) {
      this.options.onPairingUri?.(pairing.uri);
      const deepLink = `${this.deepLinkPrefix}${encodeURIComponent(pairing.uri)}`;
      if (this.options.openDeepLink) {
        this.options.openDeepLink(deepLink);
      }
    }
    return Promise.race([
      pairing.approval(),
      new Promise<WalletConnection>((_, reject) => {
        setTimeout(() => reject(new Error('LOBSTR pairing approval timed out')), this.approvalTimeoutMs);
      }),
    ]);
  }

  /**
   * Restores the existing session when the client reports it is still
   * connected, only starting a new pairing (and URI) when none exists.
   */
  async reconnect(): Promise<WalletConnection> {
    const { client } = this.options;
    if (client.getNetwork && (await client.isConnected())) {
      const [publicKey, network] = await Promise.all([
        client.getPublicKey(),
        client.getNetwork(),
      ]);
      return { publicKey, ...network };
    }
    return this.connect();
  }

  disconnect(): Promise<void> {
    return this.options.client.disconnect();
  }

  isConnected(): Promise<boolean> {
    return this.options.client.isConnected();
  }

  getPublicKey(): Promise<string> {
    return this.options.client.getPublicKey();
  }

  signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    return this.options.client.signTransaction(transactionXdr, options);
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    if (this.options.client.getNetwork) {
      return this.options.client.getNetwork();
    }
    throw new Error('LOBSTR session client does not support network detection');
  }
}
