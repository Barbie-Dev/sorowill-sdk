import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_TTL_MS, FreighterWalletAdapter, type WalletSessionOptions } from '../src/wallet';

describe('#519 Configurable session TTL via WalletSessionOptions', () => {
  it('DEFAULT_SESSION_TTL_MS defaults to 15 minutes', () => {
    expect(DEFAULT_SESSION_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('WalletSessionOptions interface accepts sessionTtlMs', () => {
    const options: WalletSessionOptions = { sessionTtlMs: 5 * 60 * 1000 };
    expect(options.sessionTtlMs).toBe(5 * 60 * 1000);
  });

  it('WalletSessionOptions sessionTtlMs is optional', () => {
    const options: WalletSessionOptions = {};
    expect(options.sessionTtlMs).toBeUndefined();
  });

  it('FreighterWalletAdapter uses DEFAULT_SESSION_TTL_MS when no sessionTtlMs provided', async () => {
    const adapter = new FreighterWalletAdapter();
    expect((adapter as any).sessionTtlMs).toBe(DEFAULT_SESSION_TTL_MS);
  });

  it('FreighterWalletAdapter uses custom sessionTtlMs when provided', async () => {
    const customTtl = 5 * 60 * 1000; // 5 minutes
    const adapter = new FreighterWalletAdapter({ sessionTtlMs: customTtl });
    expect((adapter as any).sessionTtlMs).toBe(customTtl);
  });

  it('FreighterWalletAdapter refreshSession uses custom TTL', async () => {
    const customTtl = 1000; // 1 second for fast test
    const adapter = new FreighterWalletAdapter({ sessionTtlMs: customTtl });

    // Mock getPublicKey to return a fixed value
    (adapter as any).getPublicKey = async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const session = await adapter.refreshSession();
    const expectedExpiry = Date.now() + customTtl;
    expect(session.expiresAt).toBeGreaterThanOrEqual(Date.now());
    expect(session.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100); // small tolerance
  });

  it('FreighterWalletAdapter default refreshSession uses DEFAULT_SESSION_TTL_MS', async () => {
    const adapter = new FreighterWalletAdapter();
    (adapter as any).getPublicKey = async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

    const session = await adapter.refreshSession();
    const expectedExpiry = Date.now() + DEFAULT_SESSION_TTL_MS;
    expect(session.expiresAt).toBeGreaterThanOrEqual(Date.now());
    expect(session.expiresAt).toBeLessThanOrEqual(expectedExpiry + 100); // small tolerance
  });
});