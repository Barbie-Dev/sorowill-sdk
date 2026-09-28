import type Albedo from '@albedo-link/intent';
import { Networks } from '@stellar/stellar-sdk';

import type { WalletAdapter, WalletConnection } from '../wallet';

/**
 * `@albedo-link/intent` is an optional peer dependency — consumers who only
 * use Freighter, Ledger, WalletConnect, or a custom {@link WalletAdapter} are
 * not required to install it. Its UMD bundle also assumes a browser `window`
 * global and throws immediately if evaluated outside one (e.g. in a test
 * runner), so it must be imported lazily rather than at module load time.
 */
let albedoPromise: Promise<typeof Albedo> | undefined;
function loadAlbedo(): Promise<typeof Albedo> {
  if (!albedoPromise) {
    albedoPromise = import('@albedo-link/intent').then((mod) => mod.default);
  }
  return albedoPromise;
}

/**
 * Maps a Stellar network passphrase to the network identifier Albedo expects
 * (`'public'` or `'testnet'`). Unknown passphrases — e.g. custom/standalone
 * networks — are passed through unchanged, which Albedo also accepts.
 */
function toAlbedoNetwork(networkPassphrase: string): string {
  switch (networkPassphrase) {
    case Networks.PUBLIC:
      return 'public';
    case Networks.TESTNET:
      return 'testnet';
    default:
      return networkPassphrase;
  }
}

/** Options for {@link createAlbedoAdapter}. */
export interface AlbedoAdapterOptions {
  /**
   * The Stellar network passphrase the adapter reports. Defaults to
   * `Networks.PUBLIC`.
   */
  networkPassphrase?: string;
}

/**
 * Creates a {@link WalletAdapter} backed by Albedo (https://albedo.link), a
 * web-based Stellar signer that requires no browser extension.
 *
 * ```ts
 * import { Networks } from '@stellar/stellar-sdk';
 * import { SoroWillClient, createAlbedoAdapter } from '@sorowill/sdk';
 *
 * const client = new SoroWillClient({
 *   network: 'testnet',
 *   contractId: 'C...',
 *   wallet: createAlbedoAdapter({ networkPassphrase: Networks.TESTNET }),
 * });
 * ```
 */
export function createAlbedoAdapter(options: AlbedoAdapterOptions = {}): WalletAdapter {
  const networkPassphrase = options.networkPassphrase ?? Networks.PUBLIC;
  const networkInfo = { network: toAlbedoNetwork(networkPassphrase), networkPassphrase };
  let cachedPublicKey: string | undefined;
  let connected = false;

  return {
    async isConnected(): Promise<boolean> {
      return connected;
    },

    async connect(): Promise<WalletConnection> {
      const albedo = await loadAlbedo();
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, ...networkInfo };
    },

    async reconnect(): Promise<WalletConnection> {
      if (connected && cachedPublicKey) {
        return {
          publicKey: cachedPublicKey,
          ...networkInfo,
        };
      }
      const albedo = await loadAlbedo();
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return { publicKey: pubkey, ...networkInfo };
    },

    async disconnect(): Promise<void> {
      cachedPublicKey = undefined;
      connected = false;
    },

    async getPublicKey(): Promise<string> {
      if (connected && cachedPublicKey) {
        return cachedPublicKey;
      }
      const albedo = await loadAlbedo();
      const { pubkey } = await albedo.publicKey({});
      cachedPublicKey = pubkey;
      connected = true;
      return pubkey;
    },

    async signTransaction(
      transactionXdr: string,
      opts: { networkPassphrase: string },
    ): Promise<string> {
      const albedo = await loadAlbedo();
      const { signed_envelope_xdr: signedTxXdr } = await albedo.tx({
        xdr: transactionXdr,
        network: toAlbedoNetwork(opts.networkPassphrase),
        ...(cachedPublicKey === undefined ? {} : { pubkey: cachedPublicKey }),
      });
      return signedTxXdr;
    },

    async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
      return { ...networkInfo };
    },
  };
}
