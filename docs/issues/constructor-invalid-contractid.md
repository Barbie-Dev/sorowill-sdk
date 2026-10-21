# Test SoroWillClient constructor behavior with an invalid contractId

_Tracks [GitHub #102](https://github.com/GenesisPray/sorowill-sdk/issues/102)._

## Description

`new SoroWillClient({ network, contractId })` passes `contractId` straight
into `new Contract(options.contractId)` with no validation. There's no test
verifying what happens with a malformed contract id string (wrong length,
invalid strkey) — today this throws deep inside `@stellar/stellar-sdk`'s
`Contract` constructor with a message that gives no SoroWill-specific
context.

## Evidence

- `src/SoroWillClient.ts` calls `new Contract(options.contractId)` directly
  with no surrounding validation or try/catch, at line 468 in the first
  (duplicated) constructor body and line 509 in the second — see
  [`broken-merge-sorowillclient.md`](./broken-merge-sorowillclient.md) for why
  there are currently two competing constructors in this file.
- `@stellar/stellar-sdk`'s `Contract` constructor
  (`node_modules/@stellar/stellar-sdk/lib/cjs/base/contract.js`):
  ```js
  constructor(contractId) {
    try {
      this._id = strkey.StrKey.decodeContract(contractId);
    } catch {
      throw new Error(`Invalid contract ID: ${contractId}`);
    }
  }
  ```
  confirms the failure is synchronous, thrown from inside the constructor
  call chain, and reads `Invalid contract ID: <value>` — it doesn't say which
  `SoroWillClient` option was wrong or that it came from SoroWill at all.
- The existing test suite never exercises this path: every test that
  constructs a `SoroWillClient` uses either a real testnet contract id
  (`CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE`) or the
  placeholder `'CCONTRACT'` (e.g. `test/SoroWillClient.test.ts:226`), which is
  itself an invalid strkey but is never asserted against — it's simply never
  passed through a real, unmocked `Contract` construction in those tests.

## Suggested acceptance criteria

- [x] Add a test constructing a `SoroWillClient` with an obviously invalid
      `contractId` (wrong length, bad checksum, wrong prefix) and
      document/assert the actual resulting behavior.
- [x] Since the current behavior (bare `Invalid contract ID: <value>` with no
      SoroWill context) is unhelpful, wrap construction in a try/catch that
      rethrows a clearer, SDK-specific error identifying `contractId` as the
      invalid option.
- [x] Blocked on / should land alongside the `SoroWillClient.ts` merge
      reconciliation in
      [`broken-merge-sorowillclient.md`](./broken-merge-sorowillclient.md),
      since both duplicated constructors need the same fix applied once
      (or need reconciling into one before this lands).
