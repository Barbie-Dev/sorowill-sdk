/**
 * Tests for issue #532: RpcEndpointPool doesn't validate RPC URL format
 * before use — malformed URLs could be added to the pool, causing confusing
 * network errors later instead of a clear validation error up front.
 *
 * Acceptance criteria:
 * - URL format validation when URLs are added to the pool (construction and
 *   RpcEndpointPool.add)
 * - Invalid URLs are rejected with a clear error
 * - Test covers malformed URLs
 */

import { describe, expect, it, vi } from 'vitest';

import { RpcEndpointPool } from '../src/rpc';
import type { SoroWillRpcServer } from '../src/SoroWillClient';

const PRIMARY = 'https://primary.example';
const SECONDARY = 'https://secondary.example';

/** A server double that fails every request with a connection error. */
function makeFailingServer(): SoroWillRpcServer {
  return {
    getHealth: vi.fn(async () => {
      throw new Error('fetch failed');
    }),
  } as unknown as SoroWillRpcServer;
}

describe('RpcEndpointPool — issue #532: RPC URL format validation', () => {
  // ── constructor validation ─────────────────────────────────────────────────

  it('rejects a malformed URL at construction time', () => {
    expect(() => new RpcEndpointPool(['not-a-url'])).toThrow(/Invalid RPC URL/);
  });

  it('rejects a URL with a broken scheme at construction time', () => {
    expect(() => new RpcEndpointPool(['ht!tp://bad url'])).toThrow(/Invalid RPC URL/);
  });

  it('rejects non-http(s) protocols at construction time', () => {
    expect(() => new RpcEndpointPool(['ftp://example.com'])).toThrow(/only http\(s\)/);
    expect(() => new RpcEndpointPool(['ws://example.com'])).toThrow(/only http\(s\)/);
    expect(() => new RpcEndpointPool(['file:///etc/passwd'])).toThrow(/only http\(s\)/);
  });

  it('accepts valid http(s) URLs', () => {
    expect(() => new RpcEndpointPool([PRIMARY, 'http://localhost:8000'])).not.toThrow();
  });

  // ── add() validation ───────────────────────────────────────────────────────

  it('add() rejects a malformed URL and leaves the pool unchanged', async () => {
    const pool = new RpcEndpointPool([PRIMARY], makeFailingServer());

    expect(() => pool.add('definitely not a url')).toThrow(/Invalid RPC URL/);

    // The pool must still contain only the original endpoint — the invalid
    // URL was never added, so failover never routes to it.
    const calls: string[] = [];
    await expect(
      pool.withFailover(async (_server, rpcUrl) => {
        calls.push(rpcUrl);
        throw new Error('fetch failed');
      }),
    ).rejects.toThrow('fetch failed');
    expect(calls).toEqual([PRIMARY]);
  });

  it('add() rejects non-http(s) protocols', () => {
    const pool = new RpcEndpointPool([PRIMARY], makeFailingServer());

    expect(() => pool.add('ftp://backup.example')).toThrow(/only http\(s\)/);
  });

  it('add() rejects an empty or whitespace-only URL', () => {
    const pool = new RpcEndpointPool([PRIMARY], makeFailingServer());

    expect(() => pool.add('')).toThrow(/Invalid RPC URL/);
    expect(() => pool.add('   ')).toThrow(/Invalid RPC URL/);
  });

  it('add() accepts a valid URL and makes the endpoint usable for failover', async () => {
    const primaryFailingServer = {
      getHealth: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    } as unknown as SoroWillRpcServer;
    const pool = new RpcEndpointPool([PRIMARY], primaryFailingServer);

    // With a single (failing) endpoint, there is nothing to fail over to.
    await expect(
      pool.withFailover((server) => (server as { getHealth: () => Promise<unknown> }).getHealth()),
    ).rejects.toThrow('fetch failed');

    // Add a healthy secondary endpoint, now failover can reach it.
    pool.add(` ${SECONDARY} `); // surrounding whitespace is trimmed
    const result = await pool.withFailover(async (_server, rpcUrl) => {
      if (rpcUrl === PRIMARY) {
        throw new Error('fetch failed');
      }
      return { status: 'healthy', rpcUrl };
    });
    expect(result).toEqual({ status: 'healthy', rpcUrl: SECONDARY });
  });
});
