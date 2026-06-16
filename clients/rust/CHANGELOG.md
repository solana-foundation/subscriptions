# Changelog — `subscriptions` (Rust client)

Rust SDK for the Subscriptions program. Published to crates.io; tagged `rust-client-vX.Y.Z`.

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Targets `0.4.0` (release candidate `0.4.0-rc.1` published to crates.io)._

### Added

- Instruction builders for `RevokeSubscriptionAuthority` and `RevokeAbandonedDelegation`. ([#162], [#163])
- Token-2022 transfer-hook account resolution for fixed, recurring, and subscription transfers. ([#160])

### Changed

- `create_recurring_delegation` accepts `start_ts = 0` (start on landing; requires a non-zero `expiry_ts`). ([#164])

_Releases before `0.4.0` predate this changelog; see the `rust-client-v*` tags and GitHub Releases._

[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
