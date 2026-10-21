import { InjectedWalletAdapter, type InjectedWalletProvider } from './injected';

/**
 * Adapter for a HOT Wallet Stellar provider.
 *
 * The provider is injected because HOT can be hosted in several environments
 * (web, Telegram mini-app, or mobile webview).
 *
 * ## Network behavior
 *
 * - Network reporting is delegated to the injected HOT provider: `getNetwork()`
 *   returns whatever the provider reports (via `provider.getNetwork()`), or
 *   falls back to the `network`/`networkPassphrase` captured at connect time.
 * - HOT does not let the SDK force a network: the provider decides which
 *   network the user is connected to. Always confirm
 *   `SoroWillClient.assertWalletNetwork()` after connecting so the client and
 *   wallet agree on testnet vs mainnet before signing.
 *
 * ## Known issues
 *
 * - An injected provider may report a different network than the one the app
 *   expects (e.g. user switched HOT to mainnet while the app targets testnet).
 *   This surfaces as a {@link WalletNetworkMismatchError} from the client, not
 *   a silent wrong-network signature.
 * - Hosting environment (web vs Telegram mini-app vs mobile webview) can change
 *   which provider instance is injected and thus which network it reports.
 *
 * ## Workarounds
 *
 * - Pass a provider that reports the correct network for your deployment, and
 *   call `client.assertWalletNetwork({ networkPassphrase })` after
 *   `adapter.connect()` before submitting any transaction.
 */
export class HotWalletAdapter extends InjectedWalletAdapter {
  readonly id = 'hot';
  readonly name = 'HOT Wallet';

  constructor(provider: InjectedWalletProvider) {
    super(provider);
  }
}

