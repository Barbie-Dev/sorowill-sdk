# Add a ping()/isHealthy() method wrapping server.getHealth()

_Tracks [GitHub #101](https://github.com/GenesisPray/sorowill-sdk/issues/101)._

## Description

There is no way for a consumer to proactively check whether the configured
RPC endpoint is reachable/healthy before attempting a real call — an app
currently only discovers an unreachable RPC server when the next real
`read`/`invoke` call fails, rather than being able to show a proactive
'network unavailable' banner.

## Evidence

- `SoroWillClient` exposes no `isHealthy`/`ping` method today: no occurrence
  of `getHealth`, `isHealthy`, or `ping(` anywhere under `src/`.
- The underlying RPC server already supports this check —
  `@stellar/stellar-sdk`'s `rpc.Server.getHealth()`
  (`node_modules/@stellar/stellar-sdk/lib/cjs/rpc/server.js:326`) hits the
  server's `getHealth` JSON-RPC method and is unused anywhere in this SDK.
- `this.server` (the `rpc.Server` instance) is already held as a private
  field in `SoroWillClient`, so wrapping it doesn't require adding new
  construction/config surface.

## Suggested acceptance criteria

- [x] Add `isHealthy(): Promise<boolean>` (or `ping()`) to `SoroWillClient`,
      wrapping `this.server.getHealth()`.
- [x] Ensure it never throws — network failures should resolve to `false`
      rather than propagating an exception, since this is meant for
      proactive, non-critical status checks.
- [x] Unit test covering both the healthy and unreachable cases.
- [x] Blocked on the `SoroWillClient.ts` merge reconciliation in
      [`broken-merge-sorowillclient.md`](./broken-merge-sorowillclient.md) —
      the file currently has two competing constructors/RPC strategies
      (plain `rpc.Server` retry vs. `RpcEndpointPool` + `RequestQueue`
      failover), and which one owns `getHealth()` semantics (single endpoint
      vs. pool-aware) should be decided once that's settled.
