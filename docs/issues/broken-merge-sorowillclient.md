# `src/SoroWillClient.ts` and `package.json` contain unresolved-merge duplication and likely don't compile

## Description

`src/SoroWillClient.ts` on `main` appears to contain content from multiple feature
branches merged without reconciling overlapping edits — not marked with `<<<<<<<`
conflict markers, but structurally duplicated in a way that can't be valid
TypeScript. `package.json` has a smaller version of the same problem.

This was discovered while scoping issues #88, #89, #90, and #91: several of those
changes need to touch `SoroWillClient`, and it's currently unclear which of the
duplicated blocks reflects the intended, final state of the class.

## Evidence

### `src/SoroWillClient.ts`

- **Duplicate/conflicting imports** (lines 1–51): `ReadCache`/`ReadCacheOptions`
  imported from `./cache` twice (13–17, 43); `Beneficiary, CreateWillParams,
  UpdateBeneficiariesParams, Will` imported from `./types` twice (23, 46);
  `WillStatus` imported twice (24, 47); a wallet adapter imported two different,
  incompatible ways — `getDefaultWalletAdapter` (25) vs. `freighterAdapter` (30) —
  alongside a separate `getPublicKey`/`signTransaction` free-function import (31)
  that implies a third calling convention.
- **Duplicate type alias**: `type ScVal = xdr.ScVal;` declared twice back-to-back
  (lines 27–28).
- **Duplicate `SoroWillClientOptions` fields**: `wallet` (156, 158), `readCache`
  (160, 194), `rpcUrl` (170, 190) each declared twice in the same interface.
- **Duplicate class fields**: `contract`, `networkPassphrase`, `specPromise`,
  `readCache` are each declared twice in the class body (e.g. lines 341/377,
  345/387, 347/386), with `specPromise` typed two incompatible ways
  (`Promise<InstanceType<typeof Spec>>` at 345 vs. `Promise<ContractSpecLike>`
  at 349).
- **Two constructors** for `SoroWillClient` (352 and 389) — the first uses
  `options.rpcServer`/`freighterAdapter`/a single retry-based server; the second
  uses `RpcEndpointPool`, `RequestQueue`, and per-call timeouts. They can't both
  run.
- **Two competing implementations** of `getWill`, `getWillsByOwner`,
  `getWillsByBeneficiary`, `checkIn`, `cancelWill`, `updateBeneficiaries`,
  `topUp`, `guardianTrigger`, `getSpec`, `read`, `invoke`/`submit` — one set
  built around `this.wallet` + simple retry, the other around free-function
  `getPublicKey()`/`signTransaction()` + `RpcEndpointPool.withFailover` +
  `RequestQueue`. Several of these are simply concatenated one after another
  inside the same method body (e.g. `getWill` at line 588 followed immediately
  by a second `getWill` at 590; `simulate`/`read` end mid-block into `invoke`'s
  body around lines 741–790 with no clear method boundary).
- Net effect: brace/paren nesting drifts partway through the file (see the
  region around lines 645–990), so later methods likely don't even parse as
  written.

### `package.json`

- `"@albedo-link/intent"` listed twice under `dependencies` (once pinned to
  `^0.13.0`, once to the exact version `0.13.0`).
- Structural duplication consistent with the same kind of merge issue, on a
  much smaller scale.

## Suggested acceptance criteria

- [x] Reconcile `src/SoroWillClient.ts` into a single, internally consistent
      implementation — decide which of the two constructor/adapter/RPC
      strategies (simple retry + `wallet` adapter vs. `RpcEndpointPool` +
      `RequestQueue` + free-function wallet calls) is the intended
      direction, and remove the other.
- [x] Deduplicate `SoroWillClientOptions`, imports, and class fields.
- [x] Deduplicate the `@albedo-link/intent` entry in `package.json`.
- [x] Confirm `npm run typecheck` and `npm run build` succeed afterward.
- [x] Confirm `npm test` still passes against the reconciled client.

## Why this blocks #88/#89/#90/#91

- #88 (`getWills(ids)` batch wrapper) needs to call the real `getWill`/`read`
  path and respect whichever concurrency primitive (`RequestQueue` /
  `RpcEndpointPool`) is actually in effect.
- #89 (ledger-time reconciliation) needs a real, singular `SoroWillRpcServer`
  interface/instance to call `getLatestLedger()` on.
- #90 (wallet-requirement doc table) needs a settled list of public methods —
  currently several are declared twice with different signatures.
- #91 (round-trip test) is unaffected by this file and can proceed
  independently.
