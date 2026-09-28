import { SignTransactionTimeoutError } from './errors';
import type { WalletAdapter, WalletConnection } from './wallet';

export interface WalletConnectSessionNamespace {
  accounts?: string[];
  chains?: string[];
  methods?: string[];
  events?: string[];
}

export interface WalletConnectSession {
  topic: string;
  namespaces?: Record<string, WalletConnectSessionNamespace>;
  sessionProperties?: Record<string, string>;
}

export interface WalletConnectConnectResult {
  uri?: string;
  approval(): Promise<WalletConnectSession>;
}

export interface WalletConnectClient {
  connect(options: {
    requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
    optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
    pairingTopic?: string;
  }): Promise<WalletConnectConnectResult>;
  disconnect(options: { topic: string; reason: { code: number; message: string } }): Promise<void>;
  getSession(topic: string): Promise<WalletConnectSession | null> | WalletConnectSession | null;
  request<T>(options: {
    topic: string;
    chainId: string;
    request: {
      method: string;
      params: unknown;
    };
  }): Promise<T>;
}

export interface WalletConnectSessionStore {
  getSessionTopic(): Promise<string | null> | string | null;
  setSessionTopic(topic: string): Promise<void> | void;
  clearSessionTopic(): Promise<void> | void;
}

/**
 * Shape returned by WalletConnect wallets for `stellar_signXdr`.
 * Wallets return a `SignedTransaction` object rather than a bare XDR string,
 * so the adapter must validate and unwrap it before handing it downstream.
 */
export interface SignatureResponse {
  envelope_xdr: string;
  hash?: string;
}

export interface WalletConnectAdapterOptions {
  requiredNamespaces?: Record<string, WalletConnectSessionNamespace>;
  optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
  pairingTopic?: string;
  network?: string;
  networkPassphrase?: string;
  requestChainId?: string;
  /** Defaults to `stellar_signXDR`, per the WalletConnect Stellar namespace documentation. */
  signTransactionMethod?: string;
  /**
   * Builds the signing request params. Defaults to `{ xdr }`, per the WalletConnect
   * Stellar namespace documentation.
   */
  getSignTransactionParams?(transactionXdr: string, networkPassphrase: string): unknown;
  disconnectReason?: { code: number; message: string };
  sessionStore?: WalletConnectSessionStore;
  /**
   * Milliseconds to wait for the relay to return a signed transaction before
   * rejecting with {@link SignTransactionTimeoutError}. Defaults to 120000.
   * Used when the mobile wallet fails to respond — either backgrounded, inactive,
   * or experiencing relay message loss.
   */
  timeoutMs?: number;
  /**
   * Milliseconds to wait for the wallet to approve the pairing in {@link WalletConnectAdapter.connect}
   * before rejecting. Defaults to 300000.
   */
  connectTimeoutMs?: number;
  onPairingUri?(uri: string): void | Promise<void>;
  getPublicKeyFromSession?(session: WalletConnectSession): string;
  getNetworkFromSession?(session: WalletConnectSession): { network: string; networkPassphrase: string };
  getSignedTransactionXdr?(response: unknown): string;
}

const DEFAULT_REQUIRED_NAMESPACES: Record<string, WalletConnectSessionNamespace> = {
  stellar: {
    methods: ['stellar_signXDR'],
    chains: ['stellar:pubnet', 'stellar:testnet'],
    events: [],
  },
};

const DEFAULT_DISCONNECT_REASON = { code: 6000, message: 'Disconnected by client' };
const DEFAULT_SIGN_TIMEOUT_MS = 120_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 300_000;

function getFirstAccount(session: WalletConnectSession): string | undefined {
  const namespaces = session.namespaces ?? {};
  const stellarNamespace = namespaces['stellar'];
  if (stellarNamespace?.accounts?.[0]) {
    return stellarNamespace.accounts[0];
  }

  for (const namespace of Object.values(namespaces)) {
    const account = namespace.accounts?.[0];
    if (account) {
      return account;
    }
  }
  return undefined;
}

function getDefaultPublicKeyFromSession(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a Stellar account');
  }

  const parts = account.split(':');
  return parts[parts.length - 1] ?? account;
}

function getDefaultChainId(session: WalletConnectSession): string {
  const account = getFirstAccount(session);
  if (!account) {
    throw new Error('WalletConnect session does not contain a WalletConnect chain id');
  }

  const parts = account.split(':');
  if (parts.length >= 2) {
    return `${parts[0]}:${parts[1]}`;
  }

  throw new Error('WalletConnect account is not in namespace:chain:address format');
}

function getDefaultNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
  const chainId = getDefaultChainId(session);
  switch (chainId) {
    case 'stellar:testnet':
      return { network: 'testnet', networkPassphrase: 'Test SDF Network ; September 2015' };
    case 'stellar:pubnet':
      return { network: 'mainnet', networkPassphrase: 'Public Global Stellar Network ; September 2015' };
    default:
      return {
        network: chainId,
        networkPassphrase: session.sessionProperties?.networkPassphrase ?? '',
      };
  }
}

/**
 * Validates a WalletConnect signing response and returns the signed
 * transaction envelope XDR as a string.
 *
 * Wallets may respond with either a bare XDR string or a `SignedTransaction`
 * object (`{ envelope_xdr, hash }`). Passing the object through to code that
 * expects a string causes a cast/serialization error, so we unwrap and validate
 * the response here.
 */
export function extractSignedTransactionXdr(response: unknown): string {
  if (typeof response === 'string') {
    return response;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedXDR' in response &&
    typeof response.signedXDR === 'string'
  ) {
    return response.signedXDR;
  }

  if (
    response &&
    typeof response === 'object' &&
    'signedTxXdr' in response &&
    typeof response.signedTxXdr === 'string'
  ) {
    return response.signedTxXdr;
  }

  throw new Error('WalletConnect signing response did not include a signed transaction XDR');
}

function getDefaultSignedTransactionXdr(response: unknown): string {
  return extractSignedTransactionXdr(response);
}

export class MemoryWalletConnectSessionStore implements WalletConnectSessionStore {
  private sessionTopic: string | null = null;

  async getSessionTopic(): Promise<string | null> {
    return this.sessionTopic;
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.sessionTopic = topic;
  }

  async clearSessionTopic(): Promise<void> {
    this.sessionTopic = null;
  }
}

export class LocalStorageWalletConnectSessionStore implements WalletConnectSessionStore {
  private readonly storage: Storage;
  private readonly key: string;

  constructor(storage: Storage, key = 'sorowill:walletconnect:session-topic') {
    this.storage = storage;
    this.key = key;
  }

  async getSessionTopic(): Promise<string | null> {
    return this.storage.getItem(this.key);
  }

  async setSessionTopic(topic: string): Promise<void> {
    this.storage.setItem(this.key, topic);
  }

  async clearSessionTopic(): Promise<void> {
    this.storage.removeItem(this.key);
  }
}

export class WalletConnectAdapter implements WalletAdapter {
  private readonly client: WalletConnectClient;
  private readonly options: WalletConnectAdapterOptions;
  private readonly sessionStore: WalletConnectSessionStore;
  private session: WalletConnectSession | null = null;
  private connection: WalletConnection | null = null;

  constructor(client: WalletConnectClient, options: WalletConnectAdapterOptions = {}) {
    this.client = client;
    this.options = options;
    this.sessionStore = options.sessionStore ?? new MemoryWalletConnectSessionStore();
  }

  async isConnected(): Promise<boolean> {
    if (this.session) {
      return true;
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      return false;
    }

    const session = await this.client.getSession(topic);
    return session !== null;
  }

  async connect(): Promise<WalletConnection> {
    const connectOptions: {
      requiredNamespaces: Record<string, WalletConnectSessionNamespace>;
      optionalNamespaces?: Record<string, WalletConnectSessionNamespace>;
      pairingTopic?: string;
    } = {
      requiredNamespaces: this.options.requiredNamespaces ?? DEFAULT_REQUIRED_NAMESPACES,
    };
    if (this.options.optionalNamespaces) {
      connectOptions.optionalNamespaces = this.options.optionalNamespaces;
    }
    if (this.options.pairingTopic) {
      connectOptions.pairingTopic = this.options.pairingTopic;
    }

    const connection = await this.client.connect(connectOptions);

    if (connection.uri) {
      await this.options.onPairingUri?.(connection.uri);
    }

    const connectTimeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`WalletConnect pairing approval timed out after ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
    });

    let session: WalletConnectSession;
    try {
      session = await Promise.race([connection.approval(), timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
    return this.useSession(session);
  }

  async reconnect(): Promise<WalletConnection> {
    if (this.session && this.connection) {
      const freshSession = await this.client.getSession(this.session.topic);
      if (freshSession) {
        return this.useSession(freshSession);
      }
      this.session = null;
      this.connection = null;
      await this.sessionStore.clearSessionTopic();
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      throw new Error('No WalletConnect session available to reconnect');
    }

    const session = await this.client.getSession(topic);
    if (!session) {
      throw new Error('WalletConnect session could not be restored');
    }

    return this.useSession(session);
  }

  async disconnect(): Promise<void> {
    const topic = this.session?.topic ?? (await this.sessionStore.getSessionTopic());
    if (topic) {
      await this.client.disconnect({
        topic,
        reason: this.options.disconnectReason ?? DEFAULT_DISCONNECT_REASON,
      });
    }

    this.session = null;
    this.connection = null;
    await this.sessionStore.clearSessionTopic();
  }

  async getPublicKey(): Promise<string> {
    const session = await this.requireSession();
    const resolver = this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession;
    return resolver(session);
  }

  async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
    const session = await this.requireSession();
    const resolver = this.options.getNetworkFromSession ?? getDefaultNetwork;
    return resolver(session);
  }

  async signTransaction(xdr: string): Promise<string> {
    const session = await this.requireSession();
    const chainId = this.options.requestChainId ?? getDefaultChainId(session);
    const method = this.options.signTransactionMethod ?? 'stellar_signXdr';

    const response = await this.withTimeout(
      this.client.request<unknown>({
        topic: session.topic,
        chainId,
        request: {
          method,
          params: { xdr },
        },
      }),
    );

    const extractor = this.options.getSignedTransactionXdr ?? getDefaultSignedTransactionXdr;
    return extractor(response);
  }

    const sessionNetwork = this.resolveNetwork(session);
    if (opts.networkPassphrase !== sessionNetwork.networkPassphrase) {
      throw new Error(
        `WalletConnect session is connected to ${sessionNetwork.network} (${sessionNetwork.networkPassphrase}) but transaction is for a different network (${opts.networkPassphrase})`,
      );
    }

    const topic = await this.sessionStore.getSessionTopic();
    if (!topic) {
      throw new Error('WalletConnect is not connected');
    }

    try {
      const response = await Promise.race([
        this.client.request({
          topic: session.topic,
          chainId: this.options.requestChainId ?? getDefaultChainId(session),
          request: {
            method: this.options.signTransactionMethod ?? 'stellar_signXDR',
            params: this.options.getSignTransactionParams
              ? this.options.getSignTransactionParams(transactionXdr, opts.networkPassphrase)
              : { xdr: transactionXdr },
          },
        }),
        timeoutPromise,
      ]);

      return (this.options.getSignedTransactionXdr ?? getDefaultSignedTransactionXdr)(response);
    } finally {
      clearTimeout(timeoutHandle!);
    }

    this.session = session;
    return session;
  }

  private useSession(session: WalletConnectSession): WalletConnection {
    this.session = session;
    this.connection = {
      publicKey: (this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession)(session),
      network: (this.options.getNetworkFromSession ?? getDefaultNetwork)(session).network,
    };
    void this.sessionStore.setSessionTopic(session.topic);
    return this.connection;
  }

  private buildConnection(session: WalletConnectSession): WalletConnection {
    const publicKey = (this.options.getPublicKeyFromSession ?? getDefaultPublicKeyFromSession)(session);
    const network = this.resolveNetwork(session);

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new SignTransactionTimeoutError(timeoutMs));
      }, timeoutMs);

      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private resolveNetwork(session: WalletConnectSession): { network: string; networkPassphrase: string } {
    return (
      this.options.getNetworkFromSession?.(session) ?? {
        network: this.options.network ?? getDefaultNetwork(session).network,
        networkPassphrase:
          this.options.networkPassphrase ?? getDefaultNetwork(session).networkPassphrase,
      }
    );
  }
}
