# Contributing to sorowill-sdk

This repo participates in the **Stellar Wave Program** on [Drips](https://drips.network/wave). Contribution work is tied to issues that maintainers tag for an active Wave, and contributors earn rewards proportional to the Points assigned to the issues they resolve.

## Ground rules

- **Do not start work on any issue until you have been assigned by the maintainer.** Applying to an issue does not mean you're assigned — wait for confirmation (via the Drips Wave dashboard or a direct assignment on GitHub) before opening a PR.
- Keep PRs scoped to the issue they resolve. Unrelated changes slow down review and can cost you the Wave window.
- Be responsive during an active Wave — issues must be resolved before the Wave ends for Points to be awarded.

## Error messages and sensitive data

SoroWill is a financially sensitive application. When adding or modifying errors in `src/errors.ts` or `src/SoroWillClient.ts`, follow these rules:

- **Never embed user-supplied or contract-derived values directly in `Error.message`.** Values that must not appear in a message string include: wallet addresses, contract IDs, token addresses, raw XDR blobs, and simulation error strings from the RPC node. These can all end up in a third-party error-tracking pipeline (Sentry, Datadog, etc.) if a consumer logs `error.message` without redaction.
- **Expose sensitive context as named, typed properties instead.** The SDK's `SimulationError`, `TransactionSubmissionError`, and `InvalidCursorError` classes show the pattern: the sensitive value is stored on a typed property (`.simulationError`, `.errorXdr`, `.cursor`) so callers can decide programmatically whether to log it.
- **Method names and status code enums are acceptable in messages** because they contain no user data.
- **Debug-mode logging** (`DebugLogger`) is gated behind `debug: true` in `SoroWillClientOptions`. Even inside that gate, do not log owner addresses or other wallet keys — prefer will IDs, tx hashes, and timing information only.

## Branch naming

Use the issue number in your branch name:

```
feat/N-short-description
fix/N-short-description
```

## Pull requests

- Your PR description must reference the issue it resolves (e.g. `Closes #12`).
- Make sure `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` all pass cleanly before requesting review.
- Add or update unit tests in `test/` for any behavior change to `src/utils.ts` or type validation logic.
- Keep the public API in `src/index.ts` in sync with any new exports.
- **When adding a new top-level export**, also add a row to the _Full public API_ table in `README.md` (under the appropriate section). The table is the single source of truth for what the package exposes — keeping it current helps consumers discover the API without reading the source. A missing row will be flagged during code review.
- **If your PR changes public behavior** (new features, breaking changes, deprecations, or behavioral fixes), add a bullet entry under the `[Unreleased]` section of [`CHANGELOG.md`](./CHANGELOG.md). The release workflow (`publish.yml`) triggers from published GitHub Releases, and the changelog is the authoritative record of what shipped in each version.

## Publishing

Publishing is normally handled by the GitHub release workflow (`publish.yml`), which builds explicitly before packing. If you ever publish manually from a local checkout, the `prepublishOnly` hook in `package.json` runs `npm run build` and `npm run typecheck` automatically before the package is packed, so a stale or missing `dist/` cannot be published. You do not need to run the build by hand first — but if the hook fails, fix the reported build or type errors and retry rather than bypassing it with `--ignore-scripts`.

## API reference

The full public API reference is generated from JSDoc comments via [TypeDoc](https://typedoc.org/).

### Generating locally

```bash
npm run docs:api
```

Output lands in `docs/api/` (gitignored). Open `docs/api/index.html` in a browser to browse the
generated HTML reference. Alternatively, run the command and point a local HTTP server at the
directory:

```bash
npx serve docs/api
```

### Keeping docs in sync

- Every public symbol exported from `src/index.ts` should have a JSDoc comment (`/** ... */`).
- When adding or renaming exports, re-run `npm run docs:api` locally and verify the symbol appears
  in the generated output before opening your PR.
- TypeDoc reads from `typedoc.json` at the repo root — adjust category or navigation settings
  there, not via CLI flags.

### Publishing to GitHub Pages

The reference can be published automatically via GitHub Actions. Add a workflow job such as:

```yaml
- name: Generate API docs
  run: npm run docs:api

- name: Deploy to GitHub Pages
  uses: peaceiris/actions-gh-pages@v4
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    publish_dir: docs/api
```

Trigger this job on every push to `main` (or as a separate manual/release workflow). GitHub Pages
must be enabled in the repository settings with the source set to the `gh-pages` branch. Once
deployed, the reference is reachable at
`https://sorowill.github.io/sorowill-sdk/`.

## ScVal / XDR snapshot tests

Every state-changing method encodes its arguments into Soroban `ScVal`s via
`spec.funcArgsToScVals(method, args)` before building a transaction. A future
upgrade to `@stellar/stellar-sdk` could silently change that encoding — for
example altering how `u64` or `Address` values are serialised — producing
transactions that the contract rejects, with nothing in CI catching the
regression.

Snapshot tests lock in the exact `ScVal` / XDR output for each method's
typical arguments so any encoding change is caught immediately.

### Running the snapshot tests

```bash
npm test
```

Vitest runs all tests including the snapshot suite. Snapshot files live next to
the test files under `test/__snapshots__/`.

### Reviewing a snapshot diff

When a snapshot assertion fails you will see a diff like:

```
- Snapshot  "create_will args ScVal snapshot 1"
+ Received

  - scvMap: [ { key: scvSymbol("owner"), val: scvAddress(...) }, ... ]
  + scvMap: [ { key: scvSymbol("owner"), val: scvAddress(...) }, ... ]
```

Before updating, answer these questions:

1. **What changed?** Identify the `@stellar/stellar-sdk` commit or release note
   that explains the encoding difference.
2. **Is the new encoding correct on-chain?** Simulate the new XDR against the
   deployed testnet contract (`npm run test -- --reporter=verbose`) and confirm
   it succeeds.
3. **Is the change intentional?** If a dependency upgrade deliberately changes
   encoding for correctness, the snapshot should be updated. If you cannot
   explain why the encoding changed, treat it as a potential regression and do
   not update.

### Intentionally updating snapshots

Once you have verified the new encoding is correct, update the snapshot file:

```bash
npx vitest run --update-snapshots
```

Commit **both** the source change that caused the encoding to shift (e.g. the
`package.json` version bump) **and** the updated snapshot file in the same PR,
with a description explaining why the XDR shape changed. Reviewers should be
able to cross-reference the diff against the upstream SDK changelog.

### Adding a snapshot for a new method

When you add a new state-changing method, add a corresponding snapshot
assertion in `test/sorowill-client-sdk.test.ts` (or a dedicated snapshot test
file). Use `toMatchSnapshot()` on the serialised ScVal array:

```ts
it('encodes create_will args to the expected ScVal shape', () => {
  const scVals = spec.funcArgsToScVals('create_will', {
    owner: 'GABC...',
    token: 'CABC...',
    amount: 1_000_000n,
    beneficiaries: [{ address: 'GBEN', percentage: 100 }],
    checkin_period_days: 90n,
    grace_period_days: 7n,
    guardians: [],
  });
  expect(scVals.map((v) => v.toXDR('base64'))).toMatchSnapshot();
});
```

Run `npx vitest run --update-snapshots` once to write the initial snapshot,
then commit it. All subsequent runs will assert against that baseline.

## Soroban sandbox integration tests

`test/soroban-sandbox-integration.test.ts` exercises the full will lifecycle
against a real deployed Soroban contract rather than a mock. It is skipped
automatically — not run in CI — unless all three of its required environment
variables are set:

```bash
export SOROBAN_SANDBOX_RPC_URL=http://localhost:8000  # optional, defaults to this
export SOROBAN_CONTRACT_ID=C...       # a deployed SoroW

/* … truncated 3048 chars — edit only what you need near the top … */
