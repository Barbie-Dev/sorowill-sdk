import { beforeEach, describe, expect, it, vi } from 'vitest';

const freighterApiMock = vi.hoisted(() => ({
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock('@stellar/freighter-api', () => ({
  default: freighterApiMock,
}));

import {
  connectWallet,
  FreighterWalletAdapter,
  getPublicKey,
  isFreighterInstalled,
  signTransaction,
} from '../src/wallet';

describe('isFreighterInstalled', () => {
  beforeEach(() => {
    freighterApiMock.isConnected.mockReset();
  });

  it('returns true when Freighter reports connected', async () => {
    freighterApiMock.isConnected.mockResolvedValue({ isConnected: true, error: undefined });
    await expect(isFreighterInstalled()).resolves.toBe(true);
  });

  it('returns false when Freighter reports not connected', async () => {
    freighterApiMock.isConnected.mockResolvedValue({ isConnected: false, error: undefined });
    await expect(isFreighterInstalled()).resolves.toBe(false);
  });

  it('returns false when Freighter reports an error (extension not installed)', async () => {
    freighterApiMock.isConnected.mockResolvedValue({
      isConnected: false,
      error: { code: -1, message: 'Extension not found' },
    });
    await expect(isFreighterInstalled()).resolves.toBe(false);
  });
});

describe('connectWallet', () => {
  beforeEach(() => {
    freighterApiMock.requestAccess.mockReset();
    freighterApiMock.getNetworkDetails.mockReset();
  });

  it('returns wallet connection details on successful connect', async () => {
    freighterApiMock.requestAccess.mockResolvedValue({
      address: 'GTESTACCOUNT12345678901234567890123456789012',
      error: undefined,
    });
    freighterApiMock.getNetworkDetails.mockResolvedValue({
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
      error: undefined,
    });

    const result = await connectWallet();

    expect(result).toEqual({
      publicKey: 'GTESTACCOUNT12345678901234567890123456789012',
      network: 'TESTNET',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(freighterApiMock.requestAccess).toHaveBeenCalledOnce();
    expect(freighterApiMock.getNetworkDetails).toHaveBeenCalledOnce();
  });

  it('throws when the user declines the connection request', async () => {
    freighterApiMock.requestAccess.mockResolvedValue({
      address: '',
      error: { code: 2, message: 'User declined access' },
    });

    await expect(connectWallet()).rejects.toThrow('User declined access');
  });

  it('throws when getNetworkDetails fails after successful access', async () => {
    freighterApiMock.requestAccess.mockResolvedValue({
      address: 'GTESTACCOUNT12345678901234567890123456789012',
      error: undefined,
    });
    freighterApiMock.getNetworkDetails.mockResolvedValue({
      network: '',
      networkPassphrase: '',
      error: { code: 5, message: 'Unable to retrieve network' },
    });

    await expect(connectWallet()).rejects.toThrow('Unable to retrieve network');
  });
});

describe('getPublicKey', () => {
  beforeEach(() => {
    freighterApiMock.getAddress.mockReset();
  });

  it('returns the connected public key', async () => {
    freighterApiMock.getAddress.mockResolvedValue({
      address: 'GTESTACCOUNT12345678901234567890123456789012',
      error: undefined,
    });

    await expect(getPublicKey()).resolves.toBe('GTESTACCOUNT12345678901234567890123456789012');
  });

  it('throws when no account is connected', async () => {
    freighterApiMock.getAddress.mockResolvedValue({ address: '', error: undefined });

    await expect(getPublicKey()).rejects.toThrow(
      'No Freighter account is connected. Call connectWallet() first.',
    );
  });

  it('throws when getAddress returns a Freighter-level error', async () => {
    freighterApiMock.getAddress.mockResolvedValue({
      address: '',
      error: { code: 3, message: 'Wallet locked' },
    });

    await expect(getPublicKey()).rejects.toThrow('Wallet locked');
  });
});

describe('signTransaction', () => {
  const testXdr = 'AAAAAgAAAAD...base64xdr...';
  const signedXdr = 'AAAAAgAAAAD...signed...';
  const networkPassphrase = 'Test SDF Network ; September 2015';
  const testAddress = 'GTESTACCOUNT12345678901234567890123456789012';

  beforeEach(() => {
    freighterApiMock.signTransaction.mockReset();
    freighterApiMock.getAddress.mockReset();
    freighterApiMock.getNetworkDetails.mockReset();
    // Set up default mocks for session validation
    freighterApiMock.getAddress.mockResolvedValue({
      address: testAddress,
      error: undefined,
    });
    freighterApiMock.getNetworkDetails.mockResolvedValue({
      network: 'TESTNET',
      networkPassphrase,
      error: undefined,
    });
  });

  it('returns the signed transaction XDR on success', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({
      envelope_xdr: signedXdr,
      error: undefined,
    });

    const result = await signTransaction(testXdr, { networkPassphrase });

    expect(result).toBe(signedXdr);
    expect(freighterApiMock.signTransaction).toHaveBeenCalledWith(testXdr, {
      networkPassphrase,
    });
  });

  it('throws when the user rejects the signing request', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({
      envelope_xdr: '',
      error: { code: 4, message: 'User rejected the transaction' },
    });

    await expect(signTransaction(testXdr, { networkPassphrase })).rejects.toThrow(
      'User rejected the transaction',
    );
  });

  it('throws when Freighter reports a signing error', async () => {
    freighterApiMock.signTransaction.mockResolvedValue({
      envelope_xdr: '',
      error: { code: -1, message: 'Internal signing failure' },
    });

    await expect(signTransaction(testXdr, { networkPassphrase })).rejects.toThrow(
      'Internal signing failure',
    );
  });
});

describe('FreighterWalletAdapter', () => {
  beforeEach(() => {
    freighterApiMock.isConnected.mockReset();
    freighterApiMock.requestAccess.mockReset();
    freighterApiMock.getNetworkDetails.mockReset();
    freighterApiMock.getAddress.mockReset();
    freighterApiMock.signTransaction.mockReset();
  });

  describe('isConnected', () => {
    it('returns true when Freighter is connected', async () => {
      freighterApiMock.isConnected.mockResolvedValue({ isConnected: true, error: undefined });
      const adapter = new FreighterWalletAdapter();
      await expect(adapter.isConnected()).resolves.toBe(true);
    });

    it('returns false when Freighter is not connected', async () => {
      freighterApiMock.isConnected.mockResolvedValue({ isConnected: false, error: undefined });
      const adapter = new FreighterWalletAdapter();
      await expect(adapter.isConnected()).resolves.toBe(false);
    });
  });

  describe('connect', () => {
    it('returns connection details on success', async () => {
      freighterApiMock.requestAccess.mockResolvedValue({
        address: 'GTESTACCOUNT12345678901234567890123456789012',
        error: undefined,
      });
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: 'PUBLIC',
        networkPassphrase: 'Public Global Stellar Network ; September 2015',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      const result = await adapter.connect();

      expect(result.publicKey).toBe('GTESTACCOUNT12345678901234567890123456789012');
      expect(result.network).toBe('PUBLIC');
    });

    it('throws on user decline', async () => {
      freighterApiMock.requestAccess.mockResolvedValue({
        address: '',
        error: { code: 2, message: 'Access denied' },
      });

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.connect()).rejects.toThrow('Access denied');
    });
  });

  describe('getPublicKey', () => {
    it('returns address when connected', async () => {
      freighterApiMock.getAddress.mockResolvedValue({
        address: 'GPUBLICKEY12345678901234567890123456789012',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.getPublicKey()).resolves.toBe('GPUBLICKEY12345678901234567890123456789012');
    });

    it('throws when not connected', async () => {
      freighterApiMock.getAddress.mockResolvedValue({ address: '', error: undefined });

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.getPublicKey()).rejects.toThrow(
        'No Freighter account is connected. Call connectWallet() first.',
      );
    });
  });

  describe('signTransaction', () => {
    const testAddress = 'GTESTACCOUNT12345678901234567890123456789012';
    const networkPassphrase = 'Test SDF Network ; September 2015';

    beforeEach(() => {
      freighterApiMock.signTransaction.mockReset();
      freighterApiMock.getAddress.mockReset();
      freighterApiMock.getNetworkDetails.mockReset();
      // Set up default mocks for session validation
      freighterApiMock.getAddress.mockResolvedValue({
        address: testAddress,
        error: undefined,
      });
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: 'TESTNET',
        networkPassphrase,
        error: undefined,
      });
    });

    it('returns signed XDR on success', async () => {
      freighterApiMock.signTransaction.mockResolvedValue({
        envelope_xdr: 'SIGNED_XDR',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      const result = await adapter.signTransaction('RAW_XDR', {
        networkPassphrase,
      });

      expect(result).toBe('SIGNED_XDR');
    });

    it('throws on user rejection', async () => {
      freighterApiMock.signTransaction.mockResolvedValue({
        envelope_xdr: '',
        error: { code: 4, message: 'Transaction rejected by user' },
      });

      const adapter = new FreighterWalletAdapter();
      await expect(
        adapter.signTransaction('RAW_XDR', {
          networkPassphrase,
        }),
      ).rejects.toThrow('Transaction rejected by user');
    });
  });

  describe('reconnect', () => {
    it('returns connection details using cached public key', async () => {
      freighterApiMock.getAddress.mockResolvedValue({
        address: 'GCACHEDKEY1234567890123456789012345678901',
        error: undefined,
      });
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      const result = await adapter.reconnect();

      expect(result.publicKey).toBe('GCACHEDKEY1234567890123456789012345678901');
      expect(result.network).toBe('TESTNET');
    });
  });

  describe('MIN_FREIGHTER_VERSION', () => {
    it('exports a minimum Freighter version constant', async () => {
      const { MIN_FREIGHTER_VERSION } = await import('../src/wallet');
      expect(MIN_FREIGHTER_VERSION).toBe('6.0.0');
    });
  });

  describe('Freighter version check', () => {
    beforeEach(() => {
      freighterApiMock.isConnected.mockReset();
      freighterApiMock.requestAccess.mockReset();
      freighterApiMock.getNetworkDetails.mockReset();
      freighterApiMock.getAddress.mockReset();
      // Default: freighter-api exposes a compatible version
      (freighterApiMock as unknown as { version?: string }).version = '6.1.0';
    });

    it('connect succeeds when freighter-api exposes a version at or above minimum', async () => {
      freighterApiMock.requestAccess.mockResolvedValue({
        address: 'GTESTACCOUNT12345678901234567890123456789012',
        error: undefined,
      });
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.connect()).resolves.toBeDefined();
    });

    it('connect throws when freighter-api exposes a version below minimum', async () => {
      const { FreighterInstallCheckError } = await import('../src/errors');

      (freighterApiMock as unknown as { version?: string }).version = '5.0.0';

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.connect()).rejects.toBeInstanceOf(FreighterInstallCheckError);
    });

    it('connect proceeds when freighter-api does not expose a version', async () => {
      delete (freighterApiMock as unknown as { version?: string }).version;

      freighterApiMock.requestAccess.mockResolvedValue({
        address: 'GTESTACCOUNT12345678901234567890123456789012',
        error: undefined,
      });
      freighterApiMock.getNetworkDetails.mockResolvedValue({
        network: 'TESTNET',
        networkPassphrase: 'Test SDF Network ; September 2015',
        error: undefined,
      });

      const adapter = new FreighterWalletAdapter();
      await expect(adapter.connect()).resolves.toBeDefined();
    });
  });
});
