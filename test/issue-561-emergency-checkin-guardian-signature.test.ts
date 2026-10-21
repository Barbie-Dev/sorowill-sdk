import { Account, Keypair, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';
import { InvalidGuardianSignatureError } from '../src/errors';
import { SoroWillClient, validateGuardianSignature } from '../src/SoroWillClient';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

describe('Issue #561: emergencyCheckIn guardian signature validation', () => {
  const makeStubClient = () => {
    const rawWill = {
      id: 1n,
      owner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      token: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      balance: 1000000n,
      beneficiaries: [],
      checkin_period_days: 30n,
      grace_period_days: 7n,
      last_checkin: 1000n,
      trigger_time: 1500n,
      status: 'Triggered',
      guardians: [],
      guardian_votes: 0,
    };

    const TEST_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    return new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
      readCache: false,
      wallet: {
        isConnected: async () => true,
        connect: async () => ({
          publicKey: TEST_ACCOUNT,
          network: 'testnet',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
        reconnect: async () => ({
          publicKey: TEST_ACCOUNT,
          network: 'testnet',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
        disconnect: async () => {},
        getPublicKey: async () => TEST_ACCOUNT,
        signTransaction: async (tx: string) => tx,
        getNetwork: async () => ({
          network: 'testnet',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
      },
      spec: {
        funcArgsToScVals: () => [],
        funcResToNative: () => rawWill,
      } as any,
      rpcServer: {
        getAccount: async (address: string) => new Account(address, '1'),
        getContractWasmByContractId: async () => new Uint8Array(),
        simulateTransaction: async () => ({
          result: { retval: xdr.ScVal.scvVoid() },
        }),
        prepareTransaction: async (tx: any) => tx,
        sendTransaction: async () => ({ status: 'PENDING', hash: 'txhash123' }),
        pollTransaction: async () => ({
          status: 'SUCCESS',
          createdAt: 1700000000,
          returnValue: xdr.ScVal.scvVoid(),
        }),
      } as unknown as SoroWillRpcServer,
    });
  };

  describe('validateGuardianSignature helper', () => {
    it('rejects empty, whitespace, and non-string inputs', () => {
      expect(() => validateGuardianSignature('')).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature('   ')).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature(null as any)).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature(undefined as any)).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature(123 as any)).toThrow(InvalidGuardianSignatureError);
    });

    it('rejects malformed signature strings', () => {
      expect(() => validateGuardianSignature('not-a-valid-signature')).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature('invalidBase64!!!')).toThrow(InvalidGuardianSignatureError);
      expect(() => validateGuardianSignature('12345')).toThrow(InvalidGuardianSignatureError);
    });

    it('rejects truncated signatures (wrong byte length)', () => {
      // 32-byte base64 string
      const thirtyTwoBytesBase64 = Buffer.alloc(32).toString('base64');
      expect(() => validateGuardianSignature(thirtyTwoBytesBase64)).toThrow(InvalidGuardianSignatureError);

      // 63-byte base64 string
      const sixtyThreeBytesBase64 = Buffer.alloc(63).toString('base64');
      expect(() => validateGuardianSignature(sixtyThreeBytesBase64)).toThrow(InvalidGuardianSignatureError);

      // 65-byte base64 string
      const sixtyFiveBytesBase64 = Buffer.alloc(65).toString('base64');
      expect(() => validateGuardianSignature(sixtyFiveBytesBase64)).toThrow(InvalidGuardianSignatureError);
    });

    it('rejects public keys mistakenly passed as signatures', () => {
      const pubkey = Keypair.random().publicKey();
      expect(() => validateGuardianSignature(pubkey)).toThrow(InvalidGuardianSignatureError);
    });

    it('accepts valid 64-byte Ed25519 base64 signatures', () => {
      const keypair = Keypair.random();
      const sig = keypair.sign(Buffer.from('emergency_checkin_message')).toString('base64');
      expect(() => validateGuardianSignature(sig)).not.toThrow();
    });

    it('accepts valid 64-byte Ed25519 hex signatures (128 characters)', () => {
      const keypair = Keypair.random();
      const hexSig = keypair.sign(Buffer.from('emergency_checkin_message')).toString('hex');
      expect(hexSig).toHaveLength(128);
      expect(() => validateGuardianSignature(hexSig)).not.toThrow();
    });

    it('accepts valid base64-encoded Stellar DecoratedSignatures', () => {
      const keypair = Keypair.random();
      const decorated = keypair.signDecorated(Buffer.from('emergency_checkin_message'));
      const decoratedBase64 = decorated.toXDR('base64');
      expect(() => validateGuardianSignature(decoratedBase64)).not.toThrow();
    });
  });

  describe('emergencyCheckIn with guardian signature', () => {
    it('rejects invalid signature passed as positional second argument', async () => {
      const client = makeStubClient();
      await expect(client.emergencyCheckIn('1', 'invalid-signature')).rejects.toThrow(
        InvalidGuardianSignatureError,
      );
    });

    it('rejects empty signature string passed as positional argument', async () => {
      const client = makeStubClient();
      await expect(client.emergencyCheckIn('1', '')).rejects.toThrow(
        InvalidGuardianSignatureError,
      );
    });

    it('rejects invalid signature passed in options object', async () => {
      const client = makeStubClient();
      await expect(
        client.emergencyCheckIn('1', { guardianSignature: 'not_a_valid_sig' }),
      ).rejects.toThrow(InvalidGuardianSignatureError);
    });

    it('rejects empty guardianSignatures array in options object', async () => {
      const client = makeStubClient();
      await expect(
        client.emergencyCheckIn('1', { guardianSignatures: [] }),
      ).rejects.toThrow(InvalidGuardianSignatureError);
    });

    it('rejects invalid signatures in guardianSignatures list', async () => {
      const client = makeStubClient();
      const validSig = Keypair.random().sign(Buffer.from('msg')).toString('base64');
      await expect(
        client.emergencyCheckIn('1', { guardianSignatures: [validSig, 'corrupted'] }),
      ).rejects.toThrow(InvalidGuardianSignatureError);
    });

    it('accepts valid signature and executes emergencyCheckIn successfully', async () => {
      const client = makeStubClient();
      const validSig = Keypair.random().sign(Buffer.from('emergency_checkin')).toString('base64');
      const result = await client.emergencyCheckIn('1', validSig);

      expect(result.txHash).toBe('txhash123');
      expect(result.nextDeadline).toBeInstanceOf(Date);
    });

    it('accepts valid signature in options and executes emergencyCheckIn successfully', async () => {
      const client = makeStubClient();
      const validSig = Keypair.random().sign(Buffer.from('emergency_checkin')).toString('base64');
      const result = await client.emergencyCheckIn('1', { guardianSignature: validSig });

      expect(result.txHash).toBe('txhash123');
      expect(result.nextDeadline).toBeInstanceOf(Date);
    });

    it('still works without signature for standard owner check-in', async () => {
      const client = makeStubClient();
      const result = await client.emergencyCheckIn('1');

      expect(result.txHash).toBe('txhash123');
      expect(result.nextDeadline).toBeInstanceOf(Date);
    });
  });
});
