import { InjectedWalletAdapter, type InjectedWalletProvider } from './injected';

/**
 * Adapter for Hana Wallet's injected Stellar provider.
 *
 * Pass the provider explicitly so applications can select the correct Hana
 * account/provider and tests do not depend on a browser global.
 *
 * ## Network behavior
 *
 * - Network reporting is delegated to the injected Hana provider: `getNetwork()`
 *   returns whatever the provider reports (via `provider.getNetwork()`), or
 *   falls back to the `network`/`networkPassphrase` captured at connect time.
 * - Hana does not let the SDK force a network: the provider decides which
 *   network the user is connected to. Always confirm
 *   `SoroWillClient.assertWalletNetwork()` after connecting so the client and
 *   wallet agree on testnet vs mainnet before signing.
 *
 * ## Known issues
 *
 * - An injected provider may report a different network than the one the app
 *   expects (e.g. user switched Hana to mainnet while the app targets
 *   testnet). This surfaces as a {@link WalletNetworkMismatchError} from the
 *   client, not a silent wrong-network signature.
 *
 * ## Workarounds
 *
 * - Pass a provider that reports the correct network for your deployment, and
 *   call `client.assertWalletNetwork({ networkPassphrase })` after
 *   `adapter.connect()` before submitting any transaction.
 */
export class HanaWalletAdapter extends InjectedWalletAdapter {
  readonly id = 'hana';
  readonly name = 'Hana Wallet';

  constructor(provider: InjectedWalletProvider) {
    super(provider);
  }
}

