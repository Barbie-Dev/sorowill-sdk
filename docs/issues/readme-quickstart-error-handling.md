# README Quick Start example doesn't show error handling

_Tracks [GitHub #103](https://github.com/GenesisPray/sorowill-sdk/issues/103)._

## Description

The README's Quick Start code sample calls `connectWallet()` and
`client.createWill(...)` with no `try`/`catch`, meaning a new integrator
copy-pasting the example directly would ship code with zero error handling
around wallet connection failures or transaction failures — both of which are
common, expected occurrences in a wallet-based dApp flow.

## Evidence

`README.md`, Quick Start section (lines 27–75):

- Line 36: `const wallet = await connectWallet();` — unguarded. Freighter may be
  uninstalled, locked, or the user may reject the connection prompt; all three
  reject the promise (see `src/wallet.ts`).
- Lines 62–72: `const { willId, txHash } = await client.createWill({...});` —
  unguarded. This is a state-changing Soroban invocation and can reject for
  reasons a new integrator has no way to anticipate from the example alone
  (simulation failure, insufficient balance, signing rejection, RPC timeout,
  submission failure).
- No comment anywhere in the sample hints that either call is fallible, so a
  reader has no cue to add handling themselves.

## Suggested acceptance criteria

- [x] Wrap the wallet-connection step (`connectWallet()`) and the contract-call
      step (`client.createWill(...)`) in `try`/`catch` in the Quick Start
      example.
- [x] Add a brief comment at each `catch` on what kinds of errors to expect
      there (e.g. wallet not installed / connection rejected vs. simulation,
      signing, or submission failure).
- [x] Confirm the updated snippet is still otherwise runnable as documented
      (imports, option shapes, etc. unchanged).
