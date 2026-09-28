import { Account, Keypair, Networks, Operation, TransactionBuilder } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SignTransactionTimeoutError } from '../src/errors';

const publicKeyMock = vi.fn();
const txMock = vi.fn();

vi.mock('@albedo-link/intent', () => ({
  default: {
    publicKey: (...args: unknown[]) => publicKeyMock(...args),
    tx: (...args: unknown[]) => txMock(...args),
  },
}));

import { createAlbedoAdapter } from '../src/adapters/albedo';
import { WalletNetworkMismatchError } from '../src/errors';
import { FreighterWalletAdapter, freighterAdapter, type WalletAdapter } from '../src/wallet';

// A no-op reference to prove the exported adapters are assignable to the
// public WalletAdapter interface (compile-time contract check).
const _adapters: WalletAdapter[] = [freighterAdapter, createAlbedoAdapter()];
void _adapters;

describe('freighterAdapter', () => {
  it('implements the WalletAdapter interface', () => {
    expect(typeof freighterAdapter.getPublicKey).toBe('function');
    expect(typeof freighterAdapter.signTransaction).toBe('function');
  });

  it('lets a client detect a Freighter network mismatch', async () => {
    const spy = vi
      .spyOn(FreighterWalletAdapter.prototype, 'getNetwork')
      .mockResolvedValue({ network: 'PUBLIC', networkPassphrase: Networks.PUBLIC });
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: freighterAdapter,
    });

    await expect(
      client.assertWalletNetwork({ networkPassphrase: Networks.TESTNET }),
    ).rejects.toBeInstanceOf(WalletNetworkMismatchError);
    spy.mockRestore();
  });
});

describe('createAlbedoAdapter', () => {
  beforeEach(() => {
    publicKeyMock.mockReset();
    txMock.mockReset();
  });

  it('reports the configured testnet network', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GABC' });
    const adapter = createAlbedoAdapter({ networkPassphrase: Networks.TESTNET });
    const expected = { network: 'testnet', networkPassphrase: Networks.TESTNET };

    await expect(adapter.connect()).resolves.toEqual({ publicKey: 'GABC', ...expected });
    await expect(adapter.reconnect()).resolves.toEqual({ publicKey: 'GABC', ...expected });
    await expect(adapter.getNetwork?.()).resolves.toEqual(expected);
  });

  it('returns the public key selected in Albedo', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GABC' });
    const adapter = createAlbedoAdapter();

    await expect(adapter.getPublicKey()).resolves.toBe('GABC');
  });

  it('signs a transaction and returns the signed envelope XDR', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    const signed = await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(signed).toBe('SIGNED_XDR');
    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ xdr: 'UNSIGNED_XDR', network: 'testnet' }),
    );
  });

  it('maps the public network passphrase to Albedo "public"', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.PUBLIC,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ network: 'public' }));
  });

  it('passes unknown passphrases through unchanged', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: 'Standalone Network ; February 2017',
    });

    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'Standalone Network ; February 2017' }),
    );
  });

  it('pins signatures to the previously selected public key', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GSELECTED' });
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.getPublicKey();
    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ pubkey: 'GSELECTED' }));
  });

  it('omits pubkey before any account has been selected', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    const call = txMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('pubkey');
  });
});

describe('SoroWillClient wallet injection', () => {
  it('defaults to the Freighter adapter when no wallet is supplied', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const client = new SoroWillClient({ network: 'testnet', contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR' });
    expect(client).toBeInstanceOf(SoroWillClient);
  });

  it('accepts a custom WalletAdapter', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const customWallet: WalletAdapter = {
      isConnected: vi.fn().mockResolvedValue(true),
      connect: vi.fn().mockResolvedValue({ publicKey: 'GCUSTOM', network: 'testnet', networkPassphrase: Networks.TESTNET }),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      getPublicKey: vi.fn().mockResolvedValue('GCUSTOM'),
      signTransaction: vi.fn().mockResolvedValue('SIGNED'),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: customWallet,
    });
    expect(client).toBeInstanceOf(SoroWillClient);
  });

  it('accepts the exported wallet adapter implementations as wallet options', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const clientOptions = {
      network: 'testnet' as const,
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
    };

    const wallets: WalletAdapter[] = [
      new HanaWalletAdapter(injectedProvider()),
      new HotWalletAdapter(injectedProvider()),
      new LedgerWalletAdapter({
        transport: {} as never,
        network: 'testnet',
        networkPassphrase: Networks.TESTNET,
        app: {
          getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: Buffer.alloc(32, 7) }),
          signTransaction: vi.fn().mockResolvedValue({ signature: Buffer.alloc(64) }),
        },
      }),
      new LobstrWalletAdapter({
        client: {
          connect: vi.fn().mockResolvedValue({
            uri: 'wc:pairing@2?key=value',
            approval: vi.fn().mockResolvedValue({
              publicKey: 'GLOBSTR',
              network: 'testnet',
              networkPassphrase: Networks.TESTNET,
            }),
          }),
          disconnect: vi.fn().mockResolvedValue(undefined),
          isConnected: vi.fn().mockResolvedValue(true),
          getPublicKey: vi.fn().mockResolvedValue('GLOBSTR'),
          signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
        },
      }),
    ];

    for (const wallet of wallets) {
      expect(new SoroWillClient({ ...clientOptions, wallet })).toBeInstanceOf(SoroWillClient);
    }
  });
});

import {
  HanaWalletAdapter,
  HotWalletAdapter,
  LedgerWalletAdapter,
  LobstrWalletAdapter,
  type InjectedWalletProvider,
  type LedgerStellarApp,
  type LobstrSessionClient,
} from '../src/adapters';

const connection = {
  publicKey: 'GTEST',
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
};

function injectedProvider(): InjectedWalletProvider {
  return {
    connect: vi.fn().mockResolvedValue(connection),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'signed-xdr' }),
  };
}

describe.each([
  ['HanaWalletAdapter', HanaWalletAdapter],
  ['HotWalletAdapter', HotWalletAdapter],
])('%s', (_name, Adapter) => {
  it('connects and signs through its injected provider', async () => {
    const provider = injectedProvider();
    const adapter = new Adapter(provider);

    await expect(adapter.connect()).resolves.toEqual(connection);
    await expect(
      adapter.signTransaction('unsigned-xdr', {
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toBe('signed-xdr');
    await expect(adapter.getPublicKey()).resolves.toBe('GTEST');
  });

  it('clears its local connection on disconnect', async () => {
    const adapter = new Adapter(injectedProvider());
    await adapter.connect();
    await adapter.disconnect();

    await expect(adapter.isConnected()).resolves.toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow('Call connect() first');
  });

  it('reconnect() restores an existing provider connection without prompting', async () => {
    const provider: InjectedWalletProvider = {
      ...injectedProvider(),
      isConnected: vi.fn().mockResolvedValue(true),
      getPublicKey: vi.fn().mockResolvedValue('GTEST'),
      getNetwork: vi.fn().mockResolvedValue({ network: 'testnet', networkPassphrase: Networks.TESTNET }),
    };
    const adapter = new Adapter(provider);

    await expect(adapter.reconnect()).resolves.toEqual(connection);
    expect(provider.connect).not.toHaveBeenCalled();
  });

  it('reconnect() falls back to connect() when nothing can be restored', async () => {
    const provider = injectedProvider();
    const adapter = new Adapter(provider);

    await expect(adapter.reconnect()).resolves.toEqual(connection);
    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects signTransaction() with a clear error before connect()', async () => {
    const adapter = new Adapter(injectedProvider());

    await expect(
      adapter.signTransaction('unsigned-xdr', { networkPassphrase: Networks.TESTNET }),
    ).rejects.toThrow('Call connect() first');
  });
});

describe('LobstrWalletAdapter', () => {
  function lobstrClient(overrides: Partial<LobstrSessionClient> = {}): LobstrSessionClient {
    return {
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing@2?key=value',
        approval: vi.fn().mockResolvedValue(connection),
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockResolvedValue(true),
      getPublicKey: vi.fn().mockResolvedValue('GTEST'),
      signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
      ...overrides,
    };
  }

  it('reconnect() restores a live session without a new pairing URI', async () => {
    const onPairingUri = vi.fn();
    const client = lobstrClient({
      getNetwork: vi.fn().mockResolvedValue({ network: 'testnet', networkPassphrase: Networks.TESTNET }),
    });
    const adapter = new LobstrWalletAdapter({ client, onPairingUri });

    await expect(adapter.reconnect()).resolves.toEqual(connection);
    expect(client.connect).not.toHaveBeenCalled();
    expect(onPairingUri).not.toHaveBeenCalled();
  });

  it('reconnect() starts a new pairing when no session exists', async () => {
    const onPairingUri = vi.fn();
    const client = lobstrClient({ isConnected: vi.fn().mockResolvedValue(false) });
    const adapter = new LobstrWalletAdapter({ client, onPairingUri });

    await expect(adapter.reconnect()).resolves.toEqual(connection);
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(onPairingUri).toHaveBeenCalledWith('wc:pairing@2?key=value');
  });

  it('publishes a pairing URI and waits for mobile approval', async () => {
    const approved = vi.fn().mockResolvedValue(connection);
    const onPairingUri = vi.fn();
    const openDeepLink = vi.fn();
    const client = lobstrClient({
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing@2?key=value',
        approval: approved,
      }),
    });
    const adapter = new LobstrWalletAdapter({ client, onPairingUri, openDeepLink });

    await expect(adapter.connect()).resolves.toEqual(connection);
    expect(onPairingUri).toHaveBeenCalledWith('wc:pairing@2?key=value');
    expect(openDeepLink).toHaveBeenCalledWith(
      'lobstr://wallet-connect?uri=wc%3Apairing%402%3Fkey%3Dvalue',
    );
    expect(approved).toHaveBeenCalledOnce();
  });

  it('resumes an existing session without emitting a pairing URI or deep link', async () => {
    const approved = vi.fn().mockResolvedValue(connection);
    const onPairingUri = vi.fn();
    const openDeepLink = vi.fn();
    const client = lobstrClient({
      connect: vi.fn().mockResolvedValue({ approval: approved }),
    });
    const adapter = new LobstrWalletAdapter({ client, onPairingUri, openDeepLink });

    await expect(adapter.connect()).resolves.toEqual(connection);
    expect(onPairingUri).not.toHaveBeenCalled();
    expect(openDeepLink).not.toHaveBeenCalled();
    expect(approved).toHaveBeenCalledOnce();
  });

  it('delegates disconnect() to the session client', async () => {
    const client = lobstrClient();
    const adapter = new LobstrWalletAdapter({ client });

    await adapter.disconnect();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });

  it('delegates isConnected() to the session client', async () => {
    const client = lobstrClient({ isConnected: vi.fn().mockResolvedValue(false) });
    const adapter = new LobstrWalletAdapter({ client });

    await expect(adapter.isConnected()).resolves.toBe(false);
    expect(client.isConnected).toHaveBeenCalledOnce();
  });

  it('delegates getPublicKey() to the session client', async () => {
    const client = lobstrClient({ getPublicKey: vi.fn().mockResolvedValue('GLOBSTR') });
    const adapter = new LobstrWalletAdapter({ client });

    await expect(adapter.getPublicKey()).resolves.toBe('GLOBSTR');
    expect(client.getPublicKey).toHaveBeenCalledOnce();
  });

  it('forwards signTransaction() arguments to the session client unchanged', async () => {
    const client = lobstrClient({ signTransaction: vi.fn().mockResolvedValue('signed-through') });
    const adapter = new LobstrWalletAdapter({ client });
    const options = { networkPassphrase: Networks.TESTNET };

    await expect(adapter.signTransaction('unsigned-xdr', options)).resolves.toBe('signed-through');
    expect(client.signTransaction).toHaveBeenCalledWith('unsigned-xdr', options);
  });
});

describe('LedgerWalletAdapter', () => {
  it('waits for device confirmation and returns XDR with the Ledger signature', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const transaction = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
      .setTimeout(0)
      .build();

    let confirm: ((value: { signature: Buffer }) => void) | undefined;
    const confirmation = new Promise<{ signature: Buffer }>((resolve) => {
      confirm = resolve;
    });
    const app: LedgerStellarApp = {
      getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: keypair.rawPublicKey() }),
      signTransaction: vi.fn().mockReturnValue(confirmation),
    };
    const adapter = new LedgerWalletAdapter({
      transport: {} as never,
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();

    let resolved = false;
    const signing = adapter
      .signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET })
      .then((xdr) => {
        resolved = true;
        return xdr;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    confirm?.({ signature: keypair.sign(transaction.hash()) });
    const signed = TransactionBuilder.fromXDR(await signing, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
  });

  const ledgerKeypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));

  function ledgerApp(overrides: Partial<LedgerStellarApp> = {}): LedgerStellarApp {
    return {
      getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: ledgerKeypair.rawPublicKey() }),
      signTransaction: vi.fn().mockResolvedValue({ signature: Buffer.alloc(64) }),
      ...overrides,
    };
  }

  function ledgerAdapter(app: LedgerStellarApp, timeoutMs?: number): LedgerWalletAdapter {
    return new LedgerWalletAdapter({
      transport: {} as never,
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  it('clears the public key on disconnect and reports isConnected() as false', async () => {
    const adapter = ledgerAdapter(ledgerApp());
    await adapter.connect();
    await expect(adapter.isConnected()).resolves.toBe(true);

    await adapter.disconnect();

    await expect(adapter.isConnected()).resolves.toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow('Ledger is not connected. Call connect() first.');
  });

  it('rejects getPublicKey() before connect()', async () => {
    const adapter = ledgerAdapter(ledgerApp());

    await expect(adapter.getPublicKey()).rejects.toThrow(
      'Ledger is not connected. Call connect() first.',
    );
  });

  it('rejects signTransaction() with SignTransactionTimeoutError when the device never confirms', async () => {
    const transaction = new TransactionBuilder(new Account(ledgerKeypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
      .setTimeout(0)
      .build();
    const adapter = ledgerAdapter(
      ledgerApp({ signTransaction: vi.fn().mockReturnValue(new Promise<never>(() => {})) }),
      1,
    );
    await adapter.connect();

    await expect(
      adapter.signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET }),
    ).rejects.toBeInstanceOf(SignTransactionTimeoutError);
  });
});
