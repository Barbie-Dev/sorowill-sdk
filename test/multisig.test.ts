import { describe, expect, it } from 'vitest';
import {
  Account,
  Keypair,
  Networks,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { MultisigCollector } from '../src/multisig';

const SAMPLE_TX_XDR = new TransactionBuilder(
  new Account(Keypair.random().publicKey(), '0'),
  {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  },
)
  .setTimeout(30)
  .build()
  .toXDR();

const KEYPAIR_A = Keypair.random();
const KEYPAIR_B = Keypair.random();
const SIGNER_A = KEYPAIR_A.publicKey();
const SIGNER_B = KEYPAIR_B.publicKey();
const SIG_A = KEYPAIR_A.signDecorated(Buffer.alloc(32)).toXDR('base64');
const SIG_B = KEYPAIR_B.signDecorated(Buffer.alloc(32)).toXDR('base64');

describe('MultisigCollector', () => {
  it('initialises with correct defaults', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    expect(c.transactionXdr).toBe(SAMPLE_TX_XDR);
    expect(c.networkPassphrase).toBe('Test Network');
    expect(c.threshold).toBe(2);
    expect(c.signatureCount).toBe(0);
    expect(c.isReady).toBe(false);
    expect(c.signatures).toEqual([]);
  });

  it('throws if threshold is less than 1', () => {
    expect(
      () => new MultisigCollector({ transactionXdr: '', networkPassphrase: '', threshold: 0 }),
    ).toThrow('Threshold must be an integer of at least 1');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0, -1])('rejects invalid threshold %s', (threshold) => {
    expect(
      () => new MultisigCollector({ transactionXdr: SAMPLE_TX_XDR, networkPassphrase: 'Test Network', threshold }),
    ).toThrow('Threshold must be an integer of at least 1');
  });

  it('accepts a valid integer threshold', () => {
    const c = new MultisigCollector({ transactionXdr: SAMPLE_TX_XDR, networkPassphrase: 'Test Network', threshold: 3 });
    expect(c.threshold).toBe(3);
  });

  it('fromJSON rejects corrupted threshold data', () => {
    expect(() =>
      MultisigCollector.fromJSON({
        transactionXdr: SAMPLE_TX_XDR,
        networkPassphrase: 'Test Network',
        threshold: Number.NaN,
        signatures: [],
      }),
    ).toThrow('Threshold must be an integer of at least 1');
  });

  it('adds signatures and tracks count', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, SIG_A);
    expect(c.signatureCount).toBe(1);
    expect(c.isReady).toBe(false);

    c.addSignature(SIGNER_B, SIG_B);
    expect(c.signatureCount).toBe(2);
    expect(c.isReady).toBe(true);
  });

  it('throws when the same signer signs twice', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, SIG_A);
    expect(() => c.addSignature(SIGNER_A, SIG_B)).toThrow('already signed');
  });

  it('clears signatures with reset()', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 3,
    });
    c.addSignature(SIGNER_A, SIG_A);
    c.addSignature(SIGNER_B, SIG_B);
    c.reset();
    expect(c.signatureCount).toBe(0);
    expect(c.isReady).toBe(false);
  });

  it('reports isReady when threshold is met', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    expect(c.isReady).toBe(false);
    c.addSignature(SIGNER_A, SIG_A);
    expect(c.isReady).toBe(true);
  });

  it('supports more signatures than the threshold', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    c.addSignature(SIGNER_A, SIG_A);
    c.addSignature(SIGNER_B, SIG_B);
    expect(c.signatureCount).toBe(2);
    expect(c.isReady).toBe(true);
  });

  it('serialises and deserialises with toJSON / fromJSON', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 2,
    });
    c.addSignature(SIGNER_A, SIG_A);

    const json = c.toJSON();
    expect(json.transactionXdr).toBe(SAMPLE_TX_XDR);
    expect(json.threshold).toBe(2);
    expect(json.signatures).toEqual([{ signerPublicKey: SIGNER_A, signature: SIG_A }]);

    const restored = MultisigCollector.fromJSON(json);
    expect(restored.signatureCount).toBe(1);
    expect(restored.signatures[0]?.signerPublicKey).toBe(SIGNER_A);
    expect(restored.threshold).toBe(2);
    expect(restored.toJSON()).toEqual(json);
  });

  it('returns read-only signatures array', () => {
    const c = new MultisigCollector({
      transactionXdr: SAMPLE_TX_XDR,
      networkPassphrase: 'Test Network',
      threshold: 1,
    });
    c.addSignature(SIGNER_A, SIG_A);
    const sigs = c.signatures;
    expect(sigs.length).toBe(1);
    expect(sigs[0]).toEqual({ signerPublicKey: SIGNER_A, signature: SIG_A });
  });

  it('builds a fee-bump-wrapped transaction with collected signatures', () => {
    const signer = Keypair.random();
    const feeSource = Keypair.random();
    const innerTransaction = new TransactionBuilder(new Account(signer.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .setTimeout(30)
      .build();
    const feeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
      feeSource,
      '200',
      innerTransaction,
      Networks.TESTNET,
    );
    const collector = new MultisigCollector({
      transactionXdr: feeBumpTransaction.toXDR(),
      networkPassphrase: Networks.TESTNET,
      threshold: 1,
    });

    collector.addSignature(
      signer.publicKey(),
      signer.signDecorated(innerTransaction.hash()).toXDR('base64'),
    );

    const built = collector.build();
    const builtEnvelope = built.toEnvelope();
    expect(builtEnvelope.feeBump().tx().innerTx().v1().signatures()).toHaveLength(1);
  });

  describe('addSignature validation', () => {
    const collector = () =>
      new MultisigCollector({ transactionXdr: SAMPLE_TX_XDR, networkPassphrase: Networks.TESTNET, threshold: 1 });

    it('rejects an empty signature', () => {
      expect(() => collector().addSignature(SIGNER_A, '')).toThrow('must not be empty');
    });

    it('rejects a non-base64 signature', () => {
      expect(() => collector().addSignature(SIGNER_A, 'not base64!')).toThrow(
        'not a valid base64-encoded decorated signature',
      );
    });

    it('rejects a wrong-length signature', () => {
      const short = new xdr.DecoratedSignature({
        hint: KEYPAIR_A.signatureHint(),
        signature: Buffer.alloc(10),
      }).toXDR('base64');
      expect(() => collector().addSignature(SIGNER_A, short)).toThrow('must be 64 bytes');
    });

    it('rejects a signature whose hint does not match the signer', () => {
      const c = collector();
      expect(() => c.addSignature(SIGNER_A, SIG_B)).toThrow('hint does not match');
      expect(c.isReady).toBe(false);
    });
  });
});
