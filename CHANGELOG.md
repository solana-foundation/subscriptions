# Changelog — Subscriptions program

On-chain program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, versioned by `program-vX.Y.Z` git tags.
SDK client changelogs are tracked separately: [`clients/typescript`](clients/typescript/CHANGELOG.md) and [`clients/rust`](clients/rust/CHANGELOG.md).

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Targets `program-v1.1.0` (target deploy 2026-06-26). Reproducible via `solana-verify`. **Includes breaking changes vs the deployed v1.0.0 — see Changed / Security.** Audit status: [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md)._

### Added

- `RevokeSubscriptionAuthority` (discriminator 14) — revoke the program's own SPL Token / Token-2022 delegate on a user's ATA (only when it matches the derived `SubscriptionAuthority` PDA; a foreign or absent delegate is left untouched) and close the `SubscriptionAuthority` PDA when still open, returning rent to the recorded payer (sponsor-funded closes require a matching `receiver`). Accounts: requires `subscription_authority`, optional `receiver`, `user` writable. ([#162])
- `RevokeAbandonedDelegation` — let a sponsor reclaim rent from a delegation whose token account was closed (subscription authority dead). ([#163])
- `RevokeAbandonedSubscription` (discriminator 16) — the recorded payer reclaims rent from a subscription once the subscriber's `SubscriptionAuthority` for the plan's mint is terminal (closed or `init_id` rotated); the mint is read from the bound plan to block abandonment spoofing.
- `PlanUpdatedEvent` (discriminator 6) emitted by `update_plan`.
- Token-2022 Transfer Hook support — hooked mints work end-to-end for fixed, recurring, and subscription transfers; hook accounts are forwarded transparently to Token-2022's `TransferChecked` (no `ExtraAccountMetaList` validation PDA required), up to the runtime CPI account ceiling (`MAX_CPI_ACCOUNTS`, 128). ([#160])
- The published IDL registers all emitted events (discriminators + field schemas) so indexers can decode them.
- The published IDL now models the optional sponsor `payer` (`initSubscriptionAuthority`, `createFixedDelegation`, `createRecurringDelegation`, `subscribe`) and optional `receiver` (`closeSubscriptionAuthority`) trailing accounts so generated clients name them. No on-chain change — the program has accepted these accounts since v1.0.0 (`resolve_optional_payer`); only the IDL/client modeling is new.

### Changed

- `CreateRecurringDelegation` accepts `start_ts = 0` as a sentinel: the first period starts at the on-chain clock time when the transaction lands. Requires a non-zero `expiry_ts`. ([#164])
- Tightened account and state validation. ([#163])
- **Breaking** — event wire format: transfer events gain `receiver_token_account`, `SubscriptionCreatedEvent` gains `payer`, and `SubscriptionTransferEvent` gains `puller` (appended; existing field offsets preserved, total event size changed).
- **Breaking** — `UpdatePlan` now requires two additional accounts (`event_authority`, `self_program`) for self-CPI event emission.

### Security

- **Breaking** — `resume_subscription` now requires the subscriber's `SubscriptionAuthority` and validates its owner, plan mint, and `init_id`, rejecting a stale or re-initialized authority (`StaleSubscriptionAuthority`).
- Delegation `expiry_ts` is now a hard stop for transfer execution and sponsor rent recovery; the 120s spend-time drift grace was removed (drift tolerance remains only at creation-time validation).
- `UpdatePlan` — a finite `end_ts` may only be shortened, never extended or cleared (`PlanEndTsCannotExtend`, 520).
- `UpdatePlan` — a plan owner may remove pullers from a Sunset plan (status, `end_ts`, and metadata stay immutable; the new puller set must be a subset of the current one) to revoke a compromised puller.
- `UpdatePlan` — the one-period `end_ts` horizon is enforced only when the finite end changes; re-sending the unchanged `end_ts` keeps puller removal, metadata edits, and the Active→Sunset transition available during a plan's final billing period (previously frozen with `InvalidEndTs`).
- `emit_event` rejects a `self_program` account that is not this program (`InvalidSelfProgram`, 604).
- Account kind is validated (`InvalidAccountDiscriminator`) before version migration in cancel, resume, transfer-subscription, and transfer fixed/recurring.
- Mint validators reject token-program-owned but uninitialized (zeroed) mint-sized accounts.
- Token-2022 token-account length is checked before reading the account-type byte (previously an out-of-bounds panic).
- Mint decimals are read from a length-checked offset, removing a panic path on short mint data.

### Fixed

- Recurring transfers: the final in-bounds period now bills correctly instead of being rejected with `AmountExceedsPeriodLimit`; period advancement is capped at the last boundary before a finite expiry.
- A sponsor may now revoke a fully-spent fixed delegation (remaining amount 0), not only an expired one, so rent is no longer locked on a non-expiring spent delegation.
- Recovery (revoke) paths are version-agnostic: no `MigrationRequired` on stale-version accounts, older/smaller accounts are zero-padded, and future versions may append trailing fields.
- Accept Token-2022 mints whose TLV region ends in zero padding (e.g. `Multisig::LEN`-sized); previously rejected with `InvalidToken2022MintAccountData`.
- `RecurringTransferEvent.period_end_ts` is capped at the delegation's finite `expiry_ts` (matches `transfer_subscription`).
- The published IDL models the `event_authority` default as the `eventAuthority` PDA instead of a hardcoded key, so builders resolve event accounts on cloned/local deployments.

## [1.0.0] — 2026-06-01

Initial audited mainnet release (`program-v1.0.0`, commit `0221a37`).

[Unreleased]: https://github.com/solana-foundation/subscriptions/compare/0221a37...main
[1.0.0]: https://github.com/solana-foundation/subscriptions/commit/0221a37
[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
