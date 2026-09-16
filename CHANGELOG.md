# Changelog — Subscriptions program

On-chain program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, versioned by `program-vX.Y.Z` git tags.
SDK client changelogs are tracked separately: [`clients/typescript`](clients/typescript/CHANGELOG.md) and [`clients/rust`](clients/rust/CHANGELOG.md).

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `ReclaimExcessRent` (discriminator 18) returns lamports above the rent-exempt minimum to the address recorded on a PDA, without closing it. Permissionless: the receiver must match the recorded `payer`, or the `owner` for `Plan`. An account at the floor is rejected with `NoExcessLamports` (138).

## [0.5.0] — 2026-08-10

_Target mainnet deploy 2026-08-10. Reproducible via `solana-verify`. **Includes breaking changes vs the deployed v0.4.0 — see Security.** Audit status: [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md). The deployed binary and on-chain IDL report `0.5.0-beta.1`: they were built at the release commit `364a419`, which predates this version bump._

### Added

- `CancelSubscriptionNow` (discriminator 17) immediately expires a subscription when both the subscriber and current plan owner sign. It can shorten a pending cancellation, leaves the shared `SubscriptionAuthority` intact, and allows immediate subscription revocation without creating a unilateral skip-payment path. Emits a `SubscriptionCancelledEvent` — indexers now also see this event from dual-signed immediate cancels, with `expires_at_ts` set to the cancellation time instead of the end of the current billing period. The instruction data carries `expected_current_period_start_ts`, binding the dual approval to the subscription incarnation; a signed cancellation replayed against a later re-subscription at the same PDA is rejected with `StaleSubscriptionApproval` (521). ([#221])
- `CreatePlan` accepts an optional trailing payer that funds plan rent while the merchant remains the owner, enabling sponsored plan creation. Deleting the plan still refunds the merchant, so sponsors must gate access to trusted merchants. ([#204])
- `UNKNOWN_INIT_ID` (`i64::MIN`) enables one-transaction authority initialization with `Subscribe`, `CreateFixedDelegation`, or `CreateRecurringDelegation` when the new `SubscriptionAuthority.init_id` matches the current slot. The sentinel is slot-scoped and fails for authorities created in an earlier slot; callers should pass the real `init_id` when known. ([#206])

### Security

- **Breaking** — `ResumeSubscription` now carries `expected_expires_at_ts`, the expiry the subscriber observed when signing; a mismatch is rejected with `StaleSubscriptionApproval` (521), so a stale signed resume cannot clear a later cancellation the subscriber never approved. ([#214])
- **Breaking** — `UpdatePlan` data appends the observed plan state (`expected_created_at`, `expected_end_ts`, `expected_pullers`, `expected_metadata_uri`); any mismatch with the live plan is rejected with `StalePlanApproval` (522), so a stale signed update cannot restore removed pullers or revert later edits. ([#222])
- `RevokeAbandonedDelegation` and `RevokeAbandonedSubscription` treat a closed `SubscriptionAuthority` as terminal only once the slot recorded as `init_id` has passed — within that slot a re-initialized authority recreates the same slot-derived `init_id`, so the permission was not actually dead when rent was reclaimed. ([#221])

## [0.4.0] — 2026-07-13

_Target mainnet deploy 2026-07-13. Reproducible via `solana-verify`. **Includes breaking changes vs the deployed v0.3.0 — see Changed / Security.** Audit status: [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md)._

### Added

- `RevokeSubscriptionAuthority` (discriminator 14) — revoke the program's own SPL Token / Token-2022 delegate on a user's ATA (only when it matches the derived `SubscriptionAuthority` PDA; a foreign or absent delegate is left untouched) and close the `SubscriptionAuthority` PDA when still open, returning rent to the recorded payer (sponsor-funded closes require a matching `receiver`). Accounts: requires `subscription_authority`, optional `receiver`, `user` writable. ([#162])
- `RevokeAbandonedDelegation` — let a sponsor reclaim rent from a delegation whose token account was closed (subscription authority dead). ([#163])
- `RevokeAbandonedSubscription` (discriminator 16) — the recorded payer reclaims rent from a subscription once the subscriber's `SubscriptionAuthority` for the plan's mint is terminal (closed or `init_id` rotated); the mint is read from the bound plan to block abandonment spoofing.
- `PlanUpdatedEvent` (discriminator 6) emitted by `update_plan`.
- Token-2022 Transfer Hook support — hooked mints work end-to-end for fixed, recurring, and subscription transfers; hook accounts are forwarded transparently to Token-2022's `TransferChecked` (no `ExtraAccountMetaList` validation PDA required), up to the runtime CPI account ceiling (`MAX_CPI_ACCOUNTS`, 128). ([#160])
- The published IDL registers all emitted events (discriminators + field schemas) so indexers can decode them.
- The published IDL now models the optional sponsor `payer` (`initSubscriptionAuthority`, `createFixedDelegation`, `createRecurringDelegation`, `subscribe`) and optional `receiver` (`closeSubscriptionAuthority`) trailing accounts so generated clients name them. No on-chain change — the program has accepted these accounts since v0.3.0 (`resolve_optional_payer`); only the IDL/client modeling is new.

### Changed

- `CreateRecurringDelegation` accepts `start_ts = 0` as a sentinel: the first period starts at the on-chain clock time when the transaction lands. Requires a non-zero `expiry_ts`. ([#164])
- Tightened account and state validation. ([#163])
- The last Token-2022 extension guard is removed — v0.3.0 rejected mints with a configured `TransferHook` (`MintHasTransferHook`, 121); such mints are now accepted and their hooks executed via account forwarding. The program no longer rejects any mint by extension; extension-guard error codes 118–124 are retained so existing clients keep decoding them, but are never raised. ([#160], [#186])
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

## [0.3.0] — 2026-06-01

Initial audited mainnet release (`program-v0.3.0`, commit `0221a37`).

[Unreleased]: https://github.com/solana-foundation/subscriptions/compare/program-v0.4.0...main
[0.4.0]: https://github.com/solana-foundation/subscriptions/compare/program-v0.3.0...program-v0.4.0
[0.3.0]: https://github.com/solana-foundation/subscriptions/commit/0221a37
[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
[#186]: https://github.com/solana-foundation/subscriptions/pull/186
[#204]: https://github.com/solana-foundation/subscriptions/pull/204
[#206]: https://github.com/solana-foundation/subscriptions/pull/206
[#214]: https://github.com/solana-foundation/subscriptions/pull/214
[#221]: https://github.com/solana-foundation/subscriptions/pull/221
[#222]: https://github.com/solana-foundation/subscriptions/pull/222
