<img src="./docs/logo.svg" alt="SoroWill" width="56" height="56" />

# @sorowill/sdk

**TypeScript SDK for SoroWill — trustless on-chain inheritance on Stellar Soroban**

[![npm](https://img.shields.io/npm/v/%40sorowill%2Fsdk)](https://www.npmjs.com/package/@sorowill/sdk)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## Requirements

- **Node.js 22+** (see `engines` in `package.json`) or a modern browser.
- **A Stellar wallet for any state-changing call.** Read-only methods work without a wallet, but every method that signs and submits a transaction (creating a will, checking in, claiming, etc.) needs a connected, compatible wallet. The default and most common setups are:
  - **[Freighter](https://www.freighter.app/)** browser extension — the default `freighterAdapter`. Install it from [freighter.app](https://www.freighter.app/) and install the optional peer `@stellar/freighter-api`.
  - **WalletConnect-compatible mobile wallets** (e.g. [LOBSTR](https://lobstr.co/)) via `WalletConnectAdapter` — requires a WalletConnect project ID from [WalletConnect Cloud](https://cloud.walletconnect.com/). See [Pairing LOBSTR](#pairing-lobstr).
  - Other supported adapters: Albedo (`createAlbedoAdapter()`), Ledger (`@ledgerhq/hw-app-str`, see [Connecting Ledger](#connecting-ledger)), Hana, HOT, and any injected wallet. See [Pluggable wallets](#pluggable-wallets).
  - Scripts, CI, and servers without a browser wallet can use `KeypairSigner` — see [Scripts, automation, and testing](#scripts-automation-and-testing-keypairsigner).
- **A funded account on the target network** (use [Friendbot](https://developers.stellar.org/docs/learn/fundamentals/networks#friendbot) on testnet), with the wallet switched to the same network as the client.

### Troubleshooting wallet connection

| Symptom | Likely cause and fix |
|---|---|
| `isFreighterInstalled()` returns `false` | The Freighter extension is not installed or not enabled for this site. Install it from [freighter.app](https://www.freighter.app/) and reload the page. |
| `Cannot find module '@stellar/freighter-api'` | The optional peer is missing. Run `npm install @stellar/freighter-api`, or pass a different wallet adapter. |
| Wallet network mismatch error | The wallet is on a different network (e.g. Mainnet vs Testnet). Switch the network in the wallet to match the client's `networkPassphrase`. |
| Connection prompt never appears | The user dismissed or blocked the popup, or the page is not served over `https`/`localhost`. Retry `connectWallet()` from a user gesture (click handler). |
| WalletConnect pairing hangs | Invalid/missing WalletConnect project ID, or the mobile wallet is not on the same network. Re-check the project ID and re-scan the QR code. |
| `Account not found` when submitting | The wallet's account is not funded on this network. Fund it (Friendbot on testnet) and retry. |
| Nothing works in Node.js | Browser wallets are unavailable outside a browser. Use `KeypairSigner` for scripts and tests. |

## Installation

```bash
npm install @sorowill/sdk
```

`@stellar/freighter-api` is an optional peer dependency — it backs the default `freighterAdapter` and the `isFreighterInstalled`/`connectWallet`/`getPublicKey`/`signTransaction` wallet helpers. Install it if you use the default Freighter adapter:

```bash
npm install @stellar/freighter-api
```

If you only use another adapter (e.g. `createAlbedoAdapter()`, `WalletConnectAdapter`), you can skip it.

## Quick Start

```ts
import {
  LocalStorageCachePersistenceAdapter,
  SoroWillClient,
  connectWallet,
  toStroops,
} from '@sorowill/sdk';

let wallet;
try {
  // Connect the user's Freighter wallet.
  wallet = await connectWallet();
} catch (error) {
  // Handle wallet connection failures: Freighter not installed, locked, or connection rejected
  console.error('Failed to connect wallet:', error);
  process.exit(1);
}

// Quickest way to get started — uses the maintainer-managed default testnet
// contract address (see DEFAULT_CONTRACT_IDS for the value):
const client = SoroWillClient.forNetwork('testnet', {
  readCache: {
    ttlMs: 60_000,
    persistence: new LocalStorageCachePersistenceAdapter(window.localStorage),
  },
  retry: {
    maxAttempts: 3,
    initialDelayMs: 250,
  },
  timeoutMs: 15_000,
  maxConcurrentRequests: 4,
  requestsPerSecond: 10,
});

// Or point at a specific deployment (always safe if the default may be stale):
// const client = SoroWillClient.forNetwork('testnet', {
//   contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
// });

// Or construct from environment variables in Node-based apps:
// SOROWILL_NETWORK=testnet
// SOROWILL_CONTRACT_ID=CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE
// const client = SoroWillClient.fromEnv();

// Create a will locking 1,000 USDC, split 60/40 between two beneficiaries,
// with a 90-day check-in period and a 7-day grace period.
let willId: string, txHash: string;
try {
  const result = await client.createWill({
    token: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA', // testnet USDC SAC
    amount: toStroops('1000').toString(),
    beneficiaries: [
      { address: 'GBEN...AAAA', percentage: 60 },
      { address: 'GBEN...BBBB', percentage: 40 },
    ],
    checkinPeriodDays: 90,
    gracePeriodDays: 7,
    guardians: [],
  });
  willId = result.willId;
  txHash = result.txHash;
} catch (error) {
  // Handle transaction failures: simulation failure, insufficient balance, signing rejection, RPC timeout, submission failure
  console.error('Failed to create will:', error);
  process.exit(1);
}

console.log(`Created will #${willId} in tx ${txHash}`);

// Check in periodically to reset the countdown and prove you're still active.
const { nextDeadline } = await client.checkIn(willId);
console.log(`Next check-in due by ${nextDeadline.toISOString()}`);

// Read a will's full state at any time — no wallet required.
const will = await client.getWill(willId);
console.log(will.status, will.balance, will.beneficiaries);
```

## API Reference

| Method | Description | Parameters | Returns |
|---|---|---|---|
| `createWill` | Locks a token balance and creates a new will | `CreateWillParams` | `Promise<{ willId, txHash }>` |
| `checkIn` | Resets the check-in countdown | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `triggerWill` | Starts the grace period after a missed check-in | `willId` | `Promise<{ txHash }>` |
| `emergencyCheckIn` | Cancels an in-progress trigger during the grace period | `willId` | `Promise<{ txHash, nextDeadline }>` |
| `releaseInheritance` | Distributes the balance to beneficiaries after the grace period expires | `willId` | `Promise<{ txHash }>` |
| `cancelWill` | Withdraws the full balance and closes the will | `willId` | `Promise<{ txHash, refundAmount }>` |
| `updateBeneficiaries` | Replaces the beneficiary list before the will is triggered | `UpdateBeneficiariesParams` | `Promise<{ txHash }>` |
| `topUp` | Adds more of the token to an existing will | `willId`, `amount` | `Promise<{ txHash }>` |
| `previewFee` | Simulates a state-changing method and returns its estimated Soroban resource fee | `method`, `params` | `Promise<{ resourceFee }>` |
| `getNetworkFeeStats` | Passes through network-wide classic-fee/surge-pricing stats (no wallet required) | — | `Promise<rpc.Api.GetFeeStatsResponse>` |
| `getWill` | Reads the full state of a will (no wallet required) | `willId` | `Promise<Will>` |
| `getWillsByOwner` | Lists every will owned by an address, with optional client-side pagination | `owner`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `getWillsByBeneficiary` | Lists every will an address is named in, with optional client-side pagination | `beneficiary`, `PaginationOptions?` | `Promise<Will[] \| { wills, nextCursor }>` |
| `guardianTrigger` | Casts a guardian vote; 2 of 3 forces an early release | `willId` | `Promise<{ txHash }>` |
| `batch` | Simulates, signs, and submits a single raw contract operation (Soroban allows one per transaction) | `BatchOperation[]` | `Promise<BatchResult>` |

Every method also accepts an optional final `{ timeoutMs }` argument. RPC work flows through a
shared FIFO queue configured by `maxConcurrentRequests` and `requestsPerSecond`, preventing bursts
of reads or writes from overwhelming a public endpoint. A timeout rejects with
`RequestTimeoutError`.

## Client options

Pass options to the `SoroWillClient` constructor (or to `forNetwork()`/`fromEnv()`) to configure behavior:

| Option | Type | Default | Description |
|---|---|---|---|
| `contractId` | string | Network-specific (see `DEFAULT_CONTRACT_IDS`) | Contract address on the target network |
| `rpcUrl` | string | Mainnet or Testnet endpoint | Soroban RPC endpoint for transaction operations |
| `networkPassphrase` | string | Networks.TESTNET or MAINNET | Network identifier (checked against the connected wallet) |
| `timeoutMs` | number | `30000` | Milliseconds to wait for each RPC request before rejecting with `RequestTimeoutError` |
| `maxConcurrentRequests` | number | `4` | Maximum number of simultaneous RPC requests |
| `requestsPerSecond` | number | `10` | Rate limit: max requests started per rolling one-second window |
| `pollAttempts` | number | `30` | Max attempts when polling for transaction finality; increase under mainnet congestion |
| `autoFeeBumpOnTimeout` | boolean | `false` | **When `true`: if a transaction doesn't land within the poll window, the SDK automatically rebuilds and resubmits with a higher fee.** This means a second, higher-fee transaction may be submitted on your behalf without explicit re-signing. Defaults to `false` (disabled). Set to `true` only if you want this automatic retry behavior and are prepared for the cost implication (two transactions instead of one). See the fee-bump helpers section for manual fee-bump control. |
| `transactionTimeoutSeconds` | number | `30` | Validity window (in seconds) for every built transaction; increase if your signing flow takes longer than 30 seconds (e.g. hardware wallets requiring user approval on-device) |
| `debug` | boolean | `false` | Enable structured debug logging of operation builds, simulations, and submissions (no secrets logged) |
| `readCache` | object | — | Read-cache configuration: `{ ttlMs: number, persistence?: CachePersistenceAdapter }` for in-memory or persistent caching across reloads |
| `retry` | object | — | Transient-failure retry configuration: `{ maxAttempts: number, initialDelayMs: number }` with exponential backoff |
| `wallet` | WalletAdapter | `freighterAdapter` | Wallet adapter for signing (Freighter, Ledger, WalletConnect, Hana, HOT, Albedo, LOBSTR, etc.) |
| `spec` | ContractSpec | — | Advanced: pre-loaded contract spec to skip lazy WASM fetch on first call |
| `specJson` | Uint8Array | — | Advanced: pre-loaded contract WASM bytes to skip lazy `getContractWasmByContractId` RPC call |

## Batch transactions

`batch` submits a raw contract call by its native method name and arguments:

```ts
const result = await client.batch([
  {
    method: 'check_in',
    args: { will_id: 1n, owner: wallet.publicKey },
  },
]);
```

Soroban transactions may contain only a single `InvokeHostFunction` operation, so multiple contract
calls cannot be combined into one atomic transaction. `batch` therefore accepts exactly one
operation and throws `UnsupportedBatchSizeError` for larger batches; submit each call separately.

## Debugging and structured logging

The SDK includes a built-in structured debug logger that emits JSON logs for every operation: builds, simulations, submissions, polls, successes, and errors. This is useful for diagnosing failing or slow contract calls, monitoring transaction lifecycle, and understanding RPC behavior under load.

### Enabling debug logging

Pass `debug: true` when constructing the client:

```ts
const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  debug: true,  // Enable structured logging
});
```

### Log output format

The logger emits structured JSON to the console (via `console.log`) at each step of an operation. For example, you should expect to see logs like:

```json
{
  "timestamp": "2024-01-15T10:30:45.123Z",
  "phase": "build",
  "operation": "check_in",
  "details": {
    "willId": "123",
    "owner": "GABC..."
  }
}
```

```json
{
  "timestamp": "2024-01-15T10:30:46.456Z",
  "phase": "simulate",
  "operation": "check_in",
  "details": {
    "fee": "100000"
  }
}
```

```json
{
  "timestamp": "2024-01-15T10:30:47.789Z",
  "phase": "submit",
  "operation": "check_in",
  "details": {
    "txHash": "abcd1234..."
  }
}
```

### Privacy guarantee

The DebugLogger is designed with a **no-secrets-logged guarantee**: it never logs private keys, secret seeds, or the private key material from any connected wallet. All logged data is either:

- Operation parameters (amounts, addresses, flags)
- RPC request/response metadata (fees, transaction hashes, XDR)
- Timing and diagnostic information (phases, durations, error types)

This makes it safe to forward debug logs to your own internal logging pipeline (e.g., a logging service, analytics tool, or error tracker) without worrying about leaking credentials.

### Stack traces and error reports

When `debug: true`, `error` log entries include the error's `stack` so you can pinpoint where a failure occurred. Stacks are omitted when debug logging is off.

To collect details for a support request, use `client.reportError(err)`. It returns a JSON-serializable object with the error's name, message, code, stack, cause, contract ID, and network passphrase:

```ts
try {
  await client.checkIn(willId);
} catch (err) {
  console.error(JSON.stringify(client.reportError(err), null, 2));
}
```

## Fees and Soroban resource costs

`getNetworkFeeStats()` only reports network *inclusion* fees. Soroban calls also pay a resource fee (CPU, memory, ledger I/O, storage rent) that varies per operation — a `merge_wills` with many beneficiaries costs much more than a `check_in`. Use `previewFee(method, args)` to simulate the real cost; it returns `{ resourceFee, totalFee }`. All state-changing SDK calls simulate via `prepareTransaction` before submitting, so the submitted fee always includes the simulated resource fee. See Stellar's [fees, resource limits, and metering](https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering) docs.

## Pagination order

`getWillsByOwner` and `getWillsByBeneficiary` always return wills sorted ascending by `will_id` (the SDK sorts client-side because the contract does not guarantee order), so pagination cursors are stable across calls.

## Public vs internal types

Only symbols exported from the package entry point are part of the stable API. Internal types such as Soroban's `xdr.ScVal` are not re-exported; import them from `@stellar/stellar-sdk` if needed.

## Typed errors

Contract failures are exposed as subclasses of `WillContractError`, including
`WillNotFoundError`, `NotOwnerError`, `WillNotActiveError`, `WillNotTriggeredError`,
`GracePeriodNotExpiredError`, `GracePeriodExpiredError`, `InvalidPercentagesError`,
`AlreadyVotedError`, `NotGuardianError`, `CheckinNotDueError`, `ZeroAmountError`, and
`TooManyBeneficiariesError`.

### Structured error properties and error tracking

Several SDK errors keep sensitive context as **typed properties** rather than embedding it in the
error message string. This matters when you wire up an error-tracking service (Sentry, Datadog,
etc.) — most of these services forward `error.message` automatically, so any value baked into the
message becomes a potential data-privacy leak.

| Error class | Sensitive property | What it contains |
|---|---|---|
| `SimulationError` | `.simulationError` | Raw RPC simulation error string (may include contract addresses) |
| `TransactionSubmissionError` | `.errorXdr` | Base64-encoded XDR error result from the RPC node |
| `InvalidCursorError` | `.cursor` | The user-supplied cursor value that failed validation |

When integrating with an error-tracking service, filter or redact these properties before
forwarding errors upstream:

```ts
import { SimulationError, TransactionSubmissionError } from '@sorowill/sdk';

Sentry.init({
  beforeSend(event, hint) {
    const err = hint.originalException;
    if (err instanceof SimulationError || err instanceof TransactionSubmissionError) {
      // Strip the sensitive structured property from the Sentry payload.
      event.extra = { ...event.extra, sensitiveDataRedacted: true };
    }
    return event;
  },
});
```

If the connected wallet's active network doesn't match the network `SoroWillClient` was
configured with (e.g. Freighter set to mainnet while the app instantiated a testnet client),
state-changing calls throw `WalletNetworkMismatchError` before ever building or signing a
transaction — for wallet adapters that implement the optional `getNetwork()` method. You can
also check explicitly right after connecting:

```ts
const connection = await connectWallet();
client.assertWalletNetwork(connection); // throws WalletNetworkMismatchError on mismatch
```

## Utilities

| Function | Description |
|---|---|
| `formatUSDC(stroops)` | Formats base units as a human-readable decimal string, e.g. `"1,234.50"` |
| `toStroops(usdc)` | Parses a decimal USDC string into base units as a `bigint` |
| `getTimeUntilCheckin(will)` | Seconds until the next check-in deadline (negative if overdue) |
| `isCheckinDue(will)` | Whether the check-in deadline has already passed |
| `calculateShares(balance, beneficiaries)` | Splits a balance across beneficiaries, mirroring on-chain rounding |
| `formatDeadline(date)` | Formats a `Date` as a human-readable string |
| `validateBeneficiaries(beneficiaries)` | Checks that percentages are well-formed and sum to 100 |

## Full public API

Every top-level export from `@sorowill/sdk` is listed below. When adding a new public export, add a row here too — see [CONTRIBUTING.md](./CONTRIBUTING.md).

### Client

| Export | Kind | Source module | Description |
|---|---|---|---|
| `SoroWillClient` | class | `SoroWillClient` | Main client for reading and writing to a deployed SoroWill contract |
| `DEFAULT_CONTRACT_IDS` | const | `SoroWillClient` | Maintainer-managed default contract address per network; kept in sync with `deployments/` in the contracts repo |

### Custom signing flow (advanced)

For applications that need custom signing logic (e.g. multi-sig, custom key derivation), the following `SoroWillClient` instance methods support building and submitting transactions step-by-step:

| Method | Description |
|---|---|
| `buildTransaction(method, args, sourcePublicKey?)` | Builds an **unsigned, unprepared** transaction for a contract invocation. Must be passed to `prepareTransaction()` (for simulation and fees) before signing. |
| `prepareTransaction(unsignedTxXdr)` | Simulates an unsigned transaction and attaches the footprint and resource fee estimates required by Soroban. Must be called before signing. |
| `submitSignedTransaction(signedTxXdr, options?)` | Submits a signed, prepared transaction and waits for it to reach a terminal status. Requires the transaction to have been prepared first (contains footprint and fees). |

**Important:** Signing an unprepared transaction (directly from `buildTransaction()`) will fail. The workflow is: `buildTransaction()` → `prepareTransaction()` → sign → `submitSignedTransaction()`.

### Wallet helpers (Freighter)

| Export | Kind | Source module | Description |
|---|---|---|---|
| `connectWallet` | function | `wallet` | Requests Freighter access and returns the connected public key |
| `isFreighterInstalled` | function | `wallet` | Resolves `true` if the Freighter extension is present |
| `getPublicKey` | function | `wallet` | Returns the active Freighter account's public key |
| `signTransaction` | function | `wallet` | Signs a transaction XDR string via Freighter |
| `freighterAdapter` | object | `wallet` | Pre-built `WalletAdapter` backed by Freighter; used as the default when no `wallet` option is supplied |
| `getDefaultWalletAdapter` | function | `wallet` | Returns `freighterAdapter`; exported for testing overrides |
| `FreighterWalletAdapter` | class | `wallet` | Class form of the Freighter adapter |

### Wallet adapter exports

| Export | Kind | Source module | Description |
|---|---|---|---|
| `createAlbedoAdapter` | function | `adapters/albedo` | Returns a `WalletAdapter` backed by the Albedo intent API |
| `HanaWalletAdapter` | class | `adapters` | Adapter for the Hana browser-extension wallet; accepts an injected provider |
| `HotWalletAdapter` | class | `adapters` | Adapter for the HOT wallet; accepts an injected provider |
| `LedgerWalletAdapter` | class | `adapters` | Adapter for Ledger hardware wallets via WebUSB/WebHID/Node transport |
| `LobstrWalletAdapter` | class | `adapters` | Adapter for the LOBSTR mobile wallet via WalletConnect pairing |
| `WalletConnectAdapter` | class | `walletConnect` | Generic WalletConnect adapter for any Stellar WalletConnect-compatible wallet |
| `LocalStorageWalletConnectSessionStore` | class | `walletConnect` | Persists WalletConnect sessions to `localStorage` |
| `MemoryWalletConnectSessionStore` | class | `walletConnect` | In-memory WalletConnect session store (useful for testing) |

### Cache and persistence

| Export | Kind | Source module | Description |
|---|---|---|---|
| `ReadCache` | class | `cache` | In-memory read cache with optional TTL and persistence |
| `MemoryCachePersistenceAdapter` | class | `cache` | Persistence adapter backed by an in-memory map |
| `LocalStorageCachePersistenceAdapter` | class | `cache` | Persistence adapter backed by `window.localStorage` |
| `IndexedDbCachePersistenceAdapter` | class | `cache` | Persistence adapter backed by IndexedDB |
| `createReadCacheKey` | function | `cache` | Builds a stable cache key from a method name and its arguments |

### Hooks

| Export | Kind | Source module | Description |
|---|---|---|---|
| `HookManager` | class | `hooks` | Registers and runs `beforeInvoke` / `afterInvoke` lifecycle hooks |

### Multisig

Wills can be owned by a Stellar multi-signature account. The built-in wallet adapters sign with a single key, so when the owner account's thresholds require more than one signer, collect signatures out-of-band and submit the fully signed envelope:

```ts
import {
  MultisigCollector,
  buildMultisigTransactionXdr,
  signWithSecretKey,
} from '@sorowill/sdk';

// 1. Build the unsigned transaction with the multi-sig account as source.
const txXdr = await buildMultisigTransactionXdr({
  rpcUrl,
  networkPassphrase,
  contractAddress,
  method: 'check_in',
  args: { will_id: 1n },
  sourceAccount: multisigAccountPublicKey,
});

// 2. Collect a signature from each co-signer (wallet, hardware device, or script).
const collector = new MultisigCollector({ transactionXdr: txXdr, networkPassphrase, threshold: 2 });
collector.addSignature(signerA, signWithSecretKey(txXdr, signerASecret, networkPassphrase));
collector.addSignature(signerB, signatureFromSignerB);

// 3. Once the threshold is met, submit the signed envelope.
if (collector.isReady) {
  await client.submitSignedTransaction(collector.build().toXDR());
}
```

Notes:

- Every co-signer must sign the **same** transaction XDR; signing a rebuilt transaction (different sequence number or fee) produces signatures that will not verify.
- Set `threshold` to the account's threshold for the operation (medium threshold for contract invocations), not the number of signers.
- Collect signatures before the transaction's time bound expires; otherwise rebuild and re-collect.
- `signWithSecretKey` is for scripts and testing only — never handle raw secret keys in a browser.

| Export | Kind | Source module | Description |
|---|---|---|---|
| `MultisigCollector` | class | `multisig` | Collects partial signatures for a multi-sig transaction |
| `buildMultisigTransactionXdr` | function | `multisig` | Builds an unsigned transaction XDR for multi-sig signing |
| `signWithSecretKey` | function | `multisig` | Signs a transaction XDR with a raw secret key (scripts/testing only) |

### Fee-bump helpers

| Export | Kind | Source module | Description |
|---|---|---|---|
| `buildFeeBumpXdr` | function | `feeBump` | Wraps a transaction in a fee-bump envelope |
| `signFeeBumpXdr` | function | `feeBump` | Signs a fee-bump transaction XDR |
| `submitFeeBump` | function | `feeBump` | Submits a signed fee-bump transaction |
| `submitFeeBumpTransaction` | function | `feeBump` | High-level helper: build, sign, and submit a fee-bump in one call |

### SEP-7 helpers

| Export | Kind | Source module | Description |
|---|---|---|---|
| `buildSep7TxUri` | function | `sep7` | Builds a `web+stellar:tx?...` deep-link URI for mobile wallet signing |
| `parseSep7Callback` | function | `sep7` | Parses the signed XDR returned to a SEP-7 callback URL |

### Utilities

| Export | Kind | Source module | Description |
|---|---|---|---|
| `formatUSDC` | function | `utils` | Formats stroops as a human-readable decimal string, e.g. `"1,234.50"` |
| `toStroops` | function | `utils` | Parses a decimal USDC string into base units as a `bigint` |
| `getTimeUntilCheckin` | function | `utils` | Seconds until the next check-in deadline (negative if overdue) |
| `isCheckinDue` | function | `utils` | Whether the check-in deadline has already passed |
| `calculateShares` | function | `utils` | Splits a balance across beneficiaries, mirroring on-chain rounding |
| `formatDeadline` | function | `utils` | Formats a `Date` as a human-readable string |
| `validateBeneficiaries` | function | `utils` | Checks that percentages are well-formed and sum to 100 |
| `validateGuardians` | function | `utils` | Checks that the guardian list is valid (no duplicates, ≤ `MAX_GUARDIANS`) |
| `isBeneficiary` | function | `utils` | Returns `true` if an address appears in a will's beneficiary list |
| `isGuardian` | function | `utils` | Returns `true` if an address appears in a will's guardian list |
| `getNextActionableState` | function | `utils` | Returns the next action the owner or a guardian should take for a given will state |
| `MAX_BENEFICIARIES` | const | `utils` | Maximum number of beneficiaries allowed per will |
| `MAX_GUARDIANS` | const | `utils` | Maximum number of guardians allowed per will |

### Request queue

| Export | Kind | Source module | Description |
|---|---|---|---|
| `RequestQueue` | class | `requestQueue` | FIFO queue with concurrency and rate-limit controls used internally by the client |

**Ordering guarantees.** State-changing calls (`createWill`, `checkIn`, `batch`, and other signed submissions) made on the same client are serialized per account: each one loads the sequence number, signs, submits, and waits for a terminal status — including any RPC retries and fee-bump resubmission — before the next begins. A retried operation therefore can never land after an operation issued later. Read-only RPC calls go through `RequestQueue` concurrently and carry no ordering guarantee across retries. Multiple `SoroWillClient` instances (or other apps) signing for the same account are not coordinated with each other; use a single client per account.

### Events

| Export | Kind | Source module | Description |
|---|---|---|---|
| `unsubscribeFromWillEvents` | function | `events` | Closes an active `WillEventSubscription` |

### Errors

| Export | Kind | Source module | Description |
|---|---|---|---|
| `SoroWillError` | class | `errors` | Base error for all SDK-level errors |
| `WillContractError` | class | `errors` | Base class for all typed contract errors |
| `WillNotFoundError` | class | `errors` | The will does not exist |
| `NotOwnerError` | class | `errors` | The caller is not the will's owner |
| `WillNotActiveError` | class | `errors` | The will is not in the `Active` state |
| `WillNotTriggeredError` | class | `errors` | The will has not been triggered |
| `GracePeriodNotExpiredError` | class | `errors` | The grace period has not yet expired |
| `GracePeriodExpiredError` | class | `errors` | The grace period has already expired |
| `InvalidPercentagesError` | class | `errors` | Beneficiary percentages do not sum to 100 |
| `AlreadyVotedError` | class | `errors` | The guardian has already voted in this cycle |
| `NotGuardianError` | class | `errors` | The caller is not a guardian of the will |
| `CheckinNotDueError` | class | `errors` | The check-in deadline has not yet passed |
| `ZeroAmountError` | class | `errors` | The supplied amount is zero |
| `TooManyBeneficiariesError` | class | `errors` | Exceeds the maximum number of beneficiaries |
| `RequestTimeoutError` | class | `errors` | An RPC request exceeded its configured timeout |
| `WalletNetworkMismatchError` | class | `errors` | The wallet's active network does not match the client's configured network |
| `FreighterInstallCheckError` | class | `errors` | An unexpected error occurred while checking whether Freighter is installed |
| `SoroWillRestoreRequiredError` | class | `errors` | The contract entry needs a ledger restore before it can be invoked |
| `InvalidPaginationOptionsError` | class | `errors` | The supplied pagination options are invalid |
| `InvalidDayCountError` | class | `errors` | The supplied day count is invalid |
| `mapContractError` | function | `errors` | Maps a raw Soroban error into the appropriate typed subclass |

### RPC

| Export | Kind | Source module | Description |
|---|---|---|---|
| `RpcEndpointPool` | class | `rpc` | Fails over between multiple configured RPC endpoints on retryable connection errors |
| `isRetryableRpcConnectionError` | function | `rpc` | Determines whether an error from an RPC call is a retryable connection error |

### Types

| Export | Kind | Source module | Description |
|---|---|---|---|
| `Will` | interface | `types` | Full on-chain state of a will decoded into native JS types |
| `Beneficiary` | interface | `types` | A beneficiary address and its percentage share |
| `WillStatus` | enum | `types` | Lifecycle states: `Active`, `Triggered`, `Released`, `Cancelled` |
| `WillErrorCode` | enum | `types` | Numeric error codes from the contract's `WillError` enum |
| `CreateWillParams` | interface | `types` | Parameters for `createWill` |
| `UpdateBeneficiariesParams` | interface | `types` | Parameters for `updateBeneficiaries` |
| `PaginationOptions` | interface | `types` | Client-side pagination cursor and page size |
| `PaginatedWillsResult` | interface | `types` | A page of wills plus the next-page cursor |
| `SoroWillEvent` | interface | `types` | Normalised contract event emitted by the SoroWill contract |
| `EventSubscription` | interface | `types` | Handle for an active event subscription |
| `EventSubscriptionOptions` | interface | `types` | Configuration for event subscriptions (transport, cursor, poll interval) |
| `EventSubscriptionTransport` | type | `types` | `'polling'` or `'websocket'` |
| `RequestOptions` | interface | `types` | Per-call options: `timeoutMs` and `signal` |
| `BatchOperation` | interface | `types` | A single operation for inclusion in a `batch` call |
| `BatchResult` | interface | `types` | Result of a successful `batch` submission |
| `SoroWillClientOptions` | interface | `SoroWillClient` | Full constructor options for `SoroWillClient` |
| `SoroWillNetwork` | type | `SoroWillClient` | `'testnet'` or `'mainnet'` |
| `SoroWillRpcServer` | interface | `SoroWillClient` | RPC server interface (used for testing overrides) |
| `SoroWillReadCacheOptions` | interface | `SoroWillClient` | Read-cache TTL options |
| `RpcRetryOptions` | interface | `SoroWillClient` | Retry back-off configuration |
| `WalletAdapter` | interface | `wallet` | Interface all wallet adapters must implement |
| `WalletConnection` | interface | `wallet` | Result of a successful `connect()` call |
| `WillEvent` | interface | `events` | Raw contract event passed to `WillEventSource` listeners |
| `WillEventListener` | type | `events` | Callback type for `WillEventSource.subscribe` |
| `WillEventSource` | interface | `events` | Source of will events used to invalidate the read cache |
| `WillEventSubscription` | interface | `events` | Subscription handle returned by `WillEventSource.subscribe` |
| `ReadCacheOptions` | interface | `cache` | Configuration for `ReadCache` |
| `RequestQueueOptions` | interface | `requestQueue` | Configuration for `RequestQueue` |
| `AfterInvokeContext` | interface | `hooks` | Context passed to `afterInvoke` hooks |
| `AfterInvokeHook` | type | `hooks` | Function signature for `afterInvoke` hooks |
| `BeforeInvokeContext` | interface | `hooks` | Context passed to `beforeInvoke` hooks |
| `BeforeInvokeHook` | type | `hooks` | Function signature for `beforeInvoke` hooks |
| `HookRegistry` | interface | `hooks` | `on`/`off` registration shape for hooks |
| `CollectedSignature` | interface | `multisig` | A partial signature collected by `MultisigCollector` |
| `MultisigCollectorOptions` | interface | `multisig` | Options for constructing a `MultisigCollector` |
| `FeeBumpOptions` | interface | `feeBump` | Options for `buildFeeBumpXdr` (`fee` defaults to the inner transaction fee) |
| `SubmitFeeBumpOptions` | interface | `feeBump` | Options for `submitFeeBump` |
| `BuildSep7TxUriOptions` | interface | `sep7` | Options for `buildSep7TxUri` |
| `Sep7CallbackResult` | interface | `sep7` | Parsed result of a SEP-7 callback URL |
| `NextActionableState` | type | `utils` | Return type of `getNextActionableState` |
| `WalletConnectAdapterOptions` | interface | `walletConnect` | Options for constructing a `WalletConnectAdapter` |
| `WalletConnectClient` | interface | `walletConnect` | Minimal WalletConnect client interface |
| `WalletConnectConnectResult` | interface | `walletConnect` | Result of `WalletConnectAdapter.connect()` |
| `WalletConnectSession` | interface | `walletConnect` | Active WalletConnect session |
| `WalletConnectSessionNamespace` | interface | `walletConnect` | Namespace entry in a WalletConnect session |
| `WalletConnectSessionStore` | interface | `walletConnect` | Persistence interface for WalletConnect sessions |
| `InjectedWalletProvider` | interface | `adapters` | Provider interface for injected browser extension wallets |
| `LedgerStellarApp` | interface | `adapters` | Ledger Stellar app transport interface |
| `LedgerTransport` | interface | `adapters` | Low-level Ledger transport (WebUSB/WebHID/Node) |
| `LedgerWalletAdapterOptions` | interface | `adapters` | Options for `LedgerWalletAdapter` |
| `LobstrSessionClient` | interface | `adapters` | WalletConnect session client for `LobstrWalletAdapter` |
| `LobstrWalletAdapterOptions` | interface | `adapters` | Options for `LobstrWalletAdapter` |
| `SignTransactionOptions` | interface | `adapters` | Options passed to adapter `signTransaction` methods |

## Custom fetch / environments without a global fetch

The SDK's event-polling transport uses the standard `fetch` API. In environments where `fetch` is not available globally — older Node.js versions (< 18), certain React Native runtimes, or test environments — you have two options:

### Option A — inject a fetch implementation per client

Pass any `fetch`-compatible function via the `fetch` option. This only affects the SDK's own HTTP calls (event polling):

```ts
import fetch from 'node-fetch';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  fetch: fetch as unknown as typeof globalThis.fetch,
});
```

### Option B — install a global polyfill

The underlying `@stellar/stellar-sdk` `rpc.Server` reads `globalThis.fetch` directly and does not expose a per-instance override. If you need polyfilled fetch for all Soroban RPC traffic (not just event polling), install a global polyfill once at the top of your entry point, before constructing any client:

```ts
// entry.ts — must run before any SoroWillClient is constructed
import fetch from 'cross-fetch';
globalThis.fetch = fetch;
```

Popular polyfill packages: [`node-fetch`](https://github.com/node-fetch/node-fetch) (v3+, ESM), [`cross-fetch`](https://github.com/lquixada/cross-fetch) (CJS and ESM).

> **Note:** The SDK currently targets Node.js 22+; this matches the active CI and the current `vitest`/`jsdom` runtime requirements, so no fetch polyfill is needed.

## Scripts, automation, and testing (KeypairSigner)

Every state-changing `SoroWillClient` method signs transactions through the configured `WalletAdapter`. The default adapter uses the Freighter browser extension, which requires a running browser and user approval — neither of which is available in a Node.js script, a keeper bot, or a unit test.

For those environments you can implement `WalletAdapter` directly on top of `@stellar/stellar-sdk`'s `Keypair`. No Freighter dependency is involved:

```ts
import { Keypair, Transaction, TransactionBuilder } from '@stellar/stellar-sdk';
import { SoroWillClient } from '@sorowill/sdk';
import type { WalletAdapter } from '@sorowill/sdk';

class KeypairSigner implements WalletAdapter {
  constructor(private readonly keypair: Keypair) {}

  async getPublicKey(): Promise<string> {
    return this.keypair.publicKey();
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
    const tx = TransactionBuilder.fromXDR(
      transactionXdr,
      opts.networkPassphrase,
    ) as Transaction;
    tx.sign(this.keypair);
    return tx.toXDR();
  }
}

// Load the secret from an environment variable — never hard-code it.
const signer = new KeypairSigner(Keypair.fromSecret(process.env.STELLAR_SECRET!));

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  wallet: signer,
});

const { willId } = await client.createWill({ /* ... */ });
console.log('Created will', willId);
```

> **Security warning:** `KeypairSigner` holds a raw secret key in memory. It is intended for scripts, automation, and testing only — **never use it to handle real end-user funds in a browser** or any environment where the secret could be exposed to untrusted code. For production browser applications always use a browser-extension or hardware-wallet adapter (Freighter, Albedo, Ledger, etc.) so the secret never leaves the wallet.

## Wallet helpers

`isFreighterInstalled()`, `connectWallet()`, `getPublicKey()`, and `signTransaction()` wrap the [Freighter](https://www.freighter.app/) browser extension API used by the default adapter for all state-changing calls.

`isFreighterInstalled()` resolves `false` only when the extension is genuinely absent. Any other failure (e.g. called outside a browser, or an internal Freighter error) throws a `FreighterInstallCheckError` instead of being reported as "not installed", so the app can distinguish "show an install prompt" from "something else went wrong."

## Pluggable wallets

`SoroWillClient` reads the connected account and signs transactions through a small `WalletAdapter` interface, so any Stellar wallet can be used — not just Freighter:

```ts
interface WalletAdapter {
  /**
   * Reports whether the wallet is currently connected.
   * Should return true only after a successful connect() call.
   */
  isConnected(): Promise<boolean>;

  /**
   * Initiates wallet connection and returns the connected account's details.
   * Should be called once at app startup or when the user selects the wallet.
   */
  connect(): Promise<WalletConnection>;

  /**
   * Reconnects to a previously connected wallet without user interaction.
   * Used for restoring state across page reloads or app restarts.
   */
  reconnect(): Promise<WalletConnection>;

  /**
   * Disconnects the wallet and clears all session state.
   */
  disconnect(): Promise<void>;

  /**
   * Returns the public key (Stellar address) of the connected account.
   * Throws if called before connect() or after disconnect().
   */
  getPublicKey(): Promise<string>;

  /**
   * Signs a transaction with the connected account.
   * The transaction XDR is modified in-place with the account's signature.
   * Typically displays a user confirmation prompt (e.g., from a browser extension).
   */
  signTransaction(transactionXdr: string, opts: { networkPassphrase: string; timeoutMs?: number }): Promise<string>;

  /**
   * Optional: Reports the network this wallet is currently set to.
   * If implemented, the client can cross-check the wallet's active network
   * against the client's configured network and throw WalletNetworkMismatchError
   * before building a transaction (see below).
   */
  getNetwork?(): Promise<{ network: string; networkPassphrase: string }>;
}

interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}
```

If no `wallet` is passed, the client defaults to `freighterAdapter`, so existing code keeps working unchanged. To use [Albedo](https://albedo.link) instead, pass the bundled adapter:

```ts
import { Networks } from '@stellar/stellar-sdk';
import { SoroWillClient, createAlbedoAdapter } from '@sorowill/sdk';

const client = new SoroWillClient({
  network: 'testnet',
  contractId: 'C...',
  // Defaults to the public network when no passphrase is given.
  wallet: createAlbedoAdapter({ networkPassphrase: Networks.TESTNET }),
});
```

Supporting another wallet (xBull, Rabet, Lobstr, …) requires implementing all six `WalletAdapter` methods and passing your object as the `wallet` option.

## Using wallet adapters

All adapters implement `WalletAdapter`, whose `connect`, `disconnect`,
`isConnected`, `getPublicKey`, and `signTransaction` methods make it possible
to switch wallets without changing application transaction code.

```ts
import { HanaWalletAdapter, HotWalletAdapter } from '@sorowill/sdk';

const hana = new HanaWalletAdapter(hanaProvider);
const hot = new HotWalletAdapter(hotProvider);
const connection = await hana.connect();
```

Hana and HOT accept injected providers. Explicit injection supports browser
extensions, embedded webviews, and mini-app environments while keeping wallet
permissions under the host application's control.

### Pairing LOBSTR

LOBSTR is primarily a mobile wallet, so `LobstrWalletAdapter` accepts a
WalletConnect-compatible session client. Calling `connect()` creates a pairing
and reports its URI through `onPairingUri`; desktop applications should render
that URI as a QR code. Applications may also use `openDeepLink` to open the
generated `lobstr://wallet-connect?uri=...` link on the same mobile device.
`connect()` resolves only after LOBSTR approves the session.

```ts
const lobstr = new LobstrWalletAdapter({
  client: walletConnectSession,
  onPairingUri: (uri) => showQrCode(uri),
  openDeepLink: (link) => window.location.assign(link),
});
await lobstr.connect();
```

### Connecting Ledger

Create a Ledger transport appropriate to the environment (WebUSB, WebHID, or
Node) and pass it to `LedgerWalletAdapter`. The default Stellar derivation path
is `44'/148'/0'`. `signTransaction()` sends the transaction signature base to
the Stellar app and remains pending while the device displays the confirmation
screen; it resolves with signed XDR only after the user physically approves.

```ts
const ledger = new LedgerWalletAdapter({
  transport,
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
});
await ledger.connect();
const signedXdr = await ledger.signTransaction(unsignedXdr, {
  networkPassphrase: Networks.TESTNET,
});
```
The SDK also exports a shared `WalletAdapter` interface, `FreighterWalletAdapter`, and a generic `WalletConnectAdapter` for WalletConnect-compatible Stellar wallets.

## Cache and persistence

Read methods are cached in memory by default. You can disable caching with `readCache: false`, or persist cached reads across reloads with:

- `LocalStorageCachePersistenceAdapter`
- `IndexedDbCachePersistenceAdapter`

If you already have a contract event stream, pass it as `eventSource` and cached will reads will be invalidated automatically when matching will events arrive.

## Architecture

### Lazy spec-fetch-and-cache

Every `SoroWillClient` instance needs a [`contract.Spec`](https://stellar.github.io/js-stellar-sdk/) to encode call arguments into XDR `ScVal`s and decode return values back into native JavaScript types. Rather than requiring callers to supply the spec at construction time, the SDK fetches it lazily on the first call that needs it:

1. On the first `read()` or `invoke()` call, `getSpec()` fetches the contract's compiled WASM binary from the RPC node via `getContractWasmByContractId`.
2. It derives a `Spec` instance from that WASM using `Spec.fromWasm()`.
3. The resulting `Spec` is stored as `specPromise` on the instance and reused for every subsequent call — no second WASM fetch is ever made.

**Why this design?**

- Cold-start overhead stays minimal: the SDK doesn't block construction or delay the first call with a mandatory WASM prefetch.
- Hot-path calls (e.g. repeated `getWill` reads) pay zero extra round-trips.
- When a `spec` (or `specJson`) option is provided at construction time, the WASM fetch is skipped entirely — useful for tests or environments where the spec is already known.

**Known limitations**

- **Spec staleness.** The cached `Spec` reflects the contract's WASM at the moment of the first call. If the contract is later upgraded to a new WASM (possible on Soroban), the in-memory `Spec` will be stale for the lifetime of the client instance. Call `client.refreshSpec()` to evict the cache and re-fetch, or construct a new client.

- **Poisoned promise.** If the initial WASM fetch fails (e.g. due to a transient RPC error), the cached rejection is automatically cleared so the next call transparently retries — avoiding a situation where one transient error permanently breaks the client.

- **First-call latency.** The WASM binary can be several hundred kilobytes. Under constrained network conditions, the first call to any method will be noticeably slower than subsequent calls. Pre-loading with `spec` / `specJson` at construction time eliminates this cost if the spec is already available client-side.

These tradeoffs and their planned mitigations are tracked in the issue tracker (see [#111](https://github.com/SoroWill/sorowill-sdk/issues/111), [#110](https://github.com/SoroWill/sorowill-sdk/issues/110), [#109](https://github.com/SoroWill/sorowill-sdk/issues/109), and [#108](https://github.com/SoroWill/sorowill-sdk/issues/108)).

## Local Setup

```bash
git clone https://github.com/SoroWill/sorowill-sdk.git
cd sorowill-sdk
npm ci
npm run typecheck
npm test
npm run build
```

### Dependency lock file

`package-lock.json` is committed and is the source of truth for every direct and transitive dependency version. CI installs with `npm ci` and fails if the lock file is out of sync with `package.json`.

- Use `npm ci` for a clean, reproducible install.
- When you add, remove, or upgrade a dependency, run `npm install` and commit the updated `package-lock.json` together with `package.json`.
- Do not use yarn or pnpm in this repo, and do not delete the lock file to "fix" install errors.

## Contributing via Drips Wave

This repo participates in the **Stellar Wave Program** on [Drips](https://drips.network/wave). Maintainer-tagged issues carry Point values, and contributors who resolve them during an active Wave earn a proportional share of that Wave's reward pool. See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow, and <https://drips.network/wave> for how Wave itself works.

## Handsoff notes

<!-- handsoff-issue-416 -->
- #416: getNetworkFeeStats calls RPC.getFeeStats() once and caches the result indefinitely, so fee estimates become stale across multiple calls in a long-running app
