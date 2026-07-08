# Changelog — `subscriptions` (Rust client)

Rust SDK for the Subscriptions program. Published to crates.io; tagged `rust-client-vX.Y.Z`.

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] — 2026-07-13

_Matches on-chain program `program-v0.4.0`._

### Added

- Instruction builders for `RevokeSubscriptionAuthority` (requires `subscription_authority`, optional `receiver`, `user` writable) and `RevokeAbandonedDelegation`. ([#162], [#163])
- Token-2022 transfer-hook account resolution for fixed, recurring, and subscription transfers. ([#160])
- `revokeAbandonedSubscription` instruction builder.
- Generated builders now expose the optional sponsor `payer` (`initSubscriptionAuthority`, `createFixedDelegation`, `createRecurringDelegation`, `subscribe`) and optional `receiver` (`closeSubscriptionAuthority`) accounts (the program has accepted them on-chain since v0.3.0; only the IDL/client modeling is new). Omitting them preserves the prior self-funded layout.
- Generated decoders for all program events (now registered in the IDL): transfer events include `receiverTokenAccount`, `SubscriptionCreatedEvent` includes `payer`, `SubscriptionTransferEvent` includes `puller`, plus the new `PlanUpdatedEvent`.
- Generated error variants `PlanEndTsCannotExtend` (520) and `InvalidSelfProgram` (604).

### Changed

- `create_recurring_delegation` accepts `start_ts = 0` (start on landing; requires a non-zero `expiry_ts`). ([#164])
- **Breaking** — `resume_subscription` builder adds a required `subscription_authority`.
- **Breaking** — `update_plan` builder adds required `event_authority` and `self_program` accounts.
- The `event_authority` account default is derived as the `eventAuthority` PDA instead of a fixed public key.

_Releases before `0.4.0` predate this changelog; see the `rust-client-v*` tags and GitHub Releases._

[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
