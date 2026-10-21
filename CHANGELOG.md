# Changelog

All notable changes to `@sorowill/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `SoroWillClient.forNetwork(network, overrides?)` static convenience constructor that resolves the maintainer-managed default `contractId` per network from `DEFAULT_CONTRACT_IDS`, while still allowing a full override via the optional `overrides` argument (closes #117).
- `DEFAULT_CONTRACT_IDS` exported constant mapping each `SoroWillNetwork` to its current default contract address (closes #117).
- Full public API export table added to README, listing every top-level export with its kind, source module, and a one-line description (closes #119).
- Node.js 22 is the minimum supported runtime for the SDK; the package metadata, docs, and CI are aligned to the current toolchain requirements (closes #226).
- Unit tests for `cancelWill` `refundAmount` correctness, including the primary (contract-returned value) and fallback (pre-call `getWill` balance) paths; the known race with a concurrent `topUp` is documented as a known limitation (closes #118).
- `MIGRATION.md` added to the repository root: documents every breaking change to public interfaces with before/after examples and step-by-step migration instructions (closes #501).
- `flushFeeStatsCache()` method on `SoroWillClient` for manually invalidating the per-network fee-stats cache (closes #500).
- `SoroWillClient.isHealthy()` proactive health probe wrapping the configured server's `getHealth` across the RPC pool, resolving to `false` on any failure instead of throwing (closes #101).
- Optional `deepFreeze` client option plus exported `deepFreezeObject` helper: query results (`getWill`, `getWillsByOwner`, `getWillsByBeneficiary`) are returned deeply frozen so consumers cannot mutate internal SDK state or read-cache entries.
- `CircuitBreakerOptions` for `RpcEndpointPool`: an endpoint is quarantined after `threshold` consecutive failures and skipped during failover until `cooldownMs` elapses (defaults: 3 failures / 60 s).
- `releaseInheritance()` now validates that every beneficiary account exists on-chain before submitting, throwing `BeneficiaryValidationError` instead of a post-submission contract failure.

### Fixed

- `new SoroWillClient({ contractId })` wraps invalid contract IDs in `InvalidContractIdError` (with the original strkey error as `cause`) instead of a bare stellar-sdk message (closes #102).
- `destroy()` now also clears the internal event subscription reference so a torn-down client cannot hold an already-unsubscribed listener alive.
- README Quick Start example wraps `connectWallet()` and `client.createWill()` in `try`/`catch` with comments on which failure kinds to expect in each (closes #103).

### Changed

- The WebSocket event transport now isolates listener failures per event, matching the polling transport: a listener that throws no longer aborts the remaining events in the same message batch and no longer tears down the subscription (closes #548).

- `getNetworkFeeStats()` now caches results per network passphrase rather than in a single global entry. If the connected wallet switches networks mid-session (e.g. Freighter toggled from testnet to mainnet), the cache is automatically flushed and fresh stats are fetched from the correct RPC endpoint (closes #500).
- `Beneficiary` and `Will` interfaces in `src/types.ts` now carry JSDoc `@since` version tags and **Change history** tables so consumers can determine at a glance which SDK version introduced each field or breaking change (closes #501).
- `WillStatus` enum members now carry `@since` tags indicating when each variant was introduced (closes #501).
- `CONTRIBUTING.md` updated with guidance on documenting type changes: every breaking change to a public interface or enum must include a Change history table entry, `@since` tags on affected fields, a CHANGELOG entry, and a MIGRATION.md section (closes #501).

### Changed

- Quick Start in README updated to use `SoroWillClient.forNetwork()` rather than hardcoding a `contractId` in the constructor call.
- CONTRIBUTING.md updated to require a README Full public API table row for every new top-level export.
- `mapWill` now returns shallow-copied `beneficiaries`/`guardians` arrays (and `cloneWill` deep-clones including `Date` fields) so consumer mutations cannot corrupt shared or read-cached state (closes #100).

## [0.1.1] - 2026-07-27

### Added

- Hook system (`beforeInvoke` / `afterInvoke`) for intercepting contract calls via `HookManager`.
- WalletConnect adapter with session persistence (`MemoryWalletConnectSessionStore`, `LocalStorageWalletConnectSessionStore`).
- RPC endpoint failover via `RpcEndpointPool` with automatic retry for transient connection errors.
- Persistent event-driven read caching (`ReadCache`) with `IndexedDbCachePersistenceAdapter`, `LocalStorageCachePersistenceAdapter`, and `MemoryCachePersistenceAdapter`.
- `@sorowill/sdk/react` sub-package with data-fetching hooks: `useWill`, `useWillsByOwner`, `useWillsByBeneficiary`.
- Resilient RPC batching via `RequestQueue` with concurrency, rate-limit, and timeout controls.
- Fee preview via `SoroWillClient.previewFee()`.
- Client-side pagination for `getWillsByOwner` and `getWillsByBeneficiary`.
- Event subscriptions (`subscribeToEvents`) with WebSocket and polling transports.
- `SoroWillClient.fromEnv()` for environment-driven construction.
- `batch()` method for atomic multi-operation transactions.
- `buildSep7SigningUri()` for SEP-7 deep-link generation.
- Pre-sign XDR validation via `assertPreparedTransactionMatchesIntendedOperation`.
- Multi-signature transaction support via `MultisigCollector`, `buildMultisigTransactionXdr`, and `signWithSecretKey`.
- Fee-bump transaction support via `buildFeeBumpXdr`, `signFeeBumpXdr`, `submitFeeBump`, and `submitFeeBumpTransaction`.
- Pluggable wallet adapters: Freighter, Albedo, Ledger, Hana, HOT, Lobstr, and injected browser wallets.
- `WalletAdapter` interface for custom wallet integrations.
- Typed contract errors: `WillNotFoundError`, `NotOwnerError`, `WillNotActiveError`, `WillNotTriggeredError`, `GracePeriodNotExpiredError`, `GracePeriodExpiredError`, `InvalidPercentagesError`, `AlreadyVotedError`, `NotGuardianError`, `CheckinNotDueError`, `ZeroAmountError`, `TooManyBeneficiariesError`, `RequestTimeoutError`.
- Utility helpers: `formatUSDC`, `toStroops`, `calculateShares`, `formatDeadline`, `validateBeneficiaries`, `getTimeUntilCheckin`, `isCheckinDue`.
- SEP-7 helpers: `buildSep7TxUri`, `parseSep7Callback`.

### Changed

- Public methods on `SoroWillClient` now accept an optional `RequestOptions` parameter for per-call timeout overrides.
- Read methods (`getWill`, `getWillsByOwner`, `getWillsByBeneficiary`) support optional `PaginationOptions`.
- `SoroWillClient` constructor accepts an optional `wallet` adapter, defaulting to Freighter.

## [0.1.0] - 2026-06-01

### Added

- Initial release of `@sorowill/sdk`.
- `SoroWillClient` with core methods: `createWill`, `checkIn`, `triggerWill`, `emergencyCheckIn`, `releaseInheritance`, `cancelWill`, `updateBeneficiaries`, `topUp`, `guardianTrigger`, `getWill`, `getWillsByOwner`, `getWillsByBeneficiary`.
- Freighter wallet integration via `freighterAdapter`.
- `WalletAdapter` interface, `getPublicKey`, `signTransaction`, `connectWallet`, `isFreighterInstalled`.
- `WillStatus` enum and core types (`Will`, `Beneficiary`, `CreateWillParams`, `UpdateBeneficiariesParams`).
