# Changelog — Subscriptions program

On-chain program `De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44`, versioned by `program-vX.Y.Z` git tags.
SDK client changelogs are tracked separately: [`clients/typescript`](clients/typescript/CHANGELOG.md) and [`clients/rust`](clients/rust/CHANGELOG.md).

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

_Targets `program-v1.1.0` (target deploy 2026-06-26). Additive and non-breaking; reproducible via `solana-verify`. Audit status: [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md)._

### Added

- `RevokeSubscriptionAuthority` — revoke the SPL Token / Token-2022 delegate left on a user's ATA when tearing down a `SubscriptionAuthority` (revoke + close). Fixes advisory GHSA-278q-6j9j-9c3r. ([#162])
- `RevokeAbandonedDelegation` — let a sponsor reclaim rent from a delegation whose token account was closed (subscription authority dead). ([#163])
- Token-2022 Transfer Hook support — hooked mints (e.g. PYUSD) work end-to-end for fixed, recurring, and subscription transfers. ([#160])

### Changed

- `CreateRecurringDelegation` accepts `start_ts = 0` as a sentinel: the first period starts at the on-chain clock time when the transaction lands. Requires a non-zero `expiry_ts`. ([#164])
- Tightened account and state validation (audit remediation MULT-54/53/56). ⚠️ Integrators relying on previously-lax behavior may now see validation errors. ([#163])

### Security

- Cantina delta audit remediations (MULT-54/53/56); advisory GHSA-278q-6j9j-9c3r resolved. See [`audits/AUDIT_STATUS.md`](audits/AUDIT_STATUS.md).

## [1.0.0] — 2026-06-01

Initial audited mainnet release (`program-v1.0.0`, commit `0221a37`).

[Unreleased]: https://github.com/solana-foundation/subscriptions/compare/0221a37...main
[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
