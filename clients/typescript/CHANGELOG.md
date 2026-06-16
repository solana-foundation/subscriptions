# Changelog — `@solana/subscriptions`

TypeScript SDK for the Subscriptions program. Published to npm; tagged `ts-client-vX.Y.Z`.

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Targets `0.4.0` (release candidate `0.4.0-rc.1` published to npm)._

### Added

- `revokeSubscriptionAuthority` and `revokeAbandonedDelegation` instruction builders. ([#162], [#163])
- `resolveTransferHookAccounts`, plus automatic Token-2022 transfer-hook account resolution in `transferFixed`, `transferRecurring`, and `transferSubscription` on the plugin client. ([#160])

### Changed

- `createRecurringDelegation` accepts `startTs: 0` (start on landing; requires a non-zero `expiryTs`). ([#164])

_Releases before `0.4.0` predate this changelog; see the `ts-client-v*` tags and GitHub Releases._

[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
