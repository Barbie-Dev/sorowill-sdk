# mapWill() doesn't defensively clone array fields

_Tracks [GitHub #100](https://github.com/GenesisPray/sorowill-sdk/issues/100)._

## Description

`mapWill` passes `raw.beneficiaries` and `raw.guardians` straight through into
the returned `Will` object without copying. If a consumer mutates these
arrays in place (e.g. sorting a `Will.beneficiaries` array for display), and
the SDK later adds any caching layer (as proposed in the first batch), a
shared mutable reference between the cache and a mutated display copy could
produce confusing, hard-to-trace bugs.

## Evidence

`src/SoroWillClient.ts:338-353`:

```ts
function mapWill(raw: RawWill): Will {
  return {
    id: raw.id.toString(),
    owner: raw.owner,
    token: raw.token,
    balance: raw.balance.toString(),
    beneficiaries: raw.beneficiaries,       // <- raw reference, not copied
    checkinPeriodDays: Number(raw.checkin_period_days),
    gracePeriodDays: Number(raw.grace_period_days),
    lastCheckin: new Date(Number(raw.last_checkin) * 1000),
    triggerTime: raw.trigger_time === undefined ? null : new Date(Number(raw.trigger_time) * 1000),
    status: raw.status,
    guardians: raw.guardians,               // <- raw reference, not copied
    guardianVotes: raw.guardian_votes,
  };
}
```

- `beneficiaries` (line 344) and `guardians` (line 350) are assigned directly
  from `raw`, unlike every other field on `Will`, which is copied or derived
  (`.toString()`, `Number(...)`, `new Date(...)`).
- `src/cache.ts` (`ReadCache`) already exists in this codebase and stores
  decoded results for reuse across calls — a `Will` returned from a cache hit
  and mutated by a consumer would corrupt the cached entry for every
  subsequent reader, since the array reference is shared, not the cache
  policy itself.

## Suggested acceptance criteria

- [x] Return shallow copies of `beneficiaries` and `guardians` (and any other
      array fields) from `mapWill` rather than the raw references, e.g.
      `beneficiaries: [...raw.beneficiaries]`.
- [x] Add a unit test asserting that mutating a returned `Will`'s arrays does
      not affect the result of a subsequent call for the same will (in
      particular, a call served from `ReadCache`).
