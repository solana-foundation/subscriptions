# Changelog — `@solana/subscriptions`

TypeScript SDK for the Subscriptions program. Published to npm; tagged `ts-client-vX.Y.Z`.

Versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Breaking**: the `@solana/kit` peer dependency is now `^8.5.0` (was `^7.0.0`). `@solana-program/system`, `@solana-program/token`, `@solana-program/token-2022` and `@solana/program-client-core` move to their kit 8.5 releases.

## [0.5.0] — 2026-08-10

_Matches on-chain program `program-v0.5.0`. Supersedes prereleases `0.5.0-beta.1` and `0.5.0-beta.2`._

### Added

- `cancelSubscriptionNow` generated builder, overlay, and plugin instruction. The plugin defaults the subscriber to `client.identity` and the approving plan owner to `client.payer` for sponsored cancellation flows. Requires `expectedCurrentPeriodStartTs`, the period start observed when signing. ([#221])
- `createPlan` accepts an optional `payer`; the plugin defaults it to `client.payer` when that signer differs from `client.identity`, enabling sponsored plan creation. ([#204])
- `UNKNOWN_INIT_ID` is exported for same-slot, one-transaction `SubscriptionAuthority` initialization with subscribe or delegation creation instructions. ([#206])
- Generated error constants `SUBSCRIPTIONS_ERROR__STALE_SUBSCRIPTION_APPROVAL` (521) and `SUBSCRIPTIONS_ERROR__STALE_PLAN_APPROVAL` (522). ([#214], [#222])

### Changed

- **Breaking** — `resumeSubscription` (generated builder, overlay, and plugin) requires `expectedExpiresAtTs`, the expiry observed when signing. ([#214])
- **Breaking** — `updatePlan` data adds `expectedCreatedAt`, `expectedEndTs`, `expectedPullers`, and `expectedMetadataUri`; the overlay requires them explicitly, and the plugin client fetches them from the live plan when omitted. ([#222])

## [0.4.0] — 2026-07-13

_Matches on-chain program `program-v0.4.0`._

### Added

- `revokeSubscriptionAuthority` (overlay derives `subscriptionAuthority`, accepts an optional `receiver`; `user` writable) and `revokeAbandonedDelegation` instruction builders. ([#162], [#163])
- `resolveTransferHookAccounts`, plus automatic Token-2022 transfer-hook account resolution in `transferFixed`, `transferRecurring`, and `transferSubscription` on the plugin client. ([#160])
- `revokeAbandonedSubscription` instruction builder.
- Generated builders now expose the optional sponsor `payer` (`initSubscriptionAuthority`, `createFixedDelegation`, `createRecurringDelegation`, `subscribe`) and optional `receiver` (`closeSubscriptionAuthority`) accounts (the program has accepted them on-chain since v0.3.0; only the IDL/client modeling is new). Omitting them preserves the prior self-funded layout.
- Decoders for all program events (now registered in the IDL): transfer events include `receiverTokenAccount`, `SubscriptionCreatedEvent` includes `payer`, `SubscriptionTransferEvent` includes `puller`, plus the new `PlanUpdatedEvent`.
- Generated error constants `SUBSCRIPTIONS_ERROR__PLAN_END_TS_CANNOT_EXTEND` (520) and `SUBSCRIPTIONS_ERROR__INVALID_SELF_PROGRAM` (604).

### Changed

- `createRecurringDelegation` accepts `startTs: 0` (start on landing; requires a non-zero `expiryTs`). ([#164])
- **Breaking** — `resumeSubscription`: `ResumeSubscriptionInput` now requires `tokenMint`; the overlay derives and passes the `SubscriptionAuthority` PDA, and the regenerated builder adds the required `subscriptionAuthority` account.
- **Breaking** — `updatePlan` overlay is now async: `getUpdatePlanOverlayInstruction` returns `Promise<Instruction>`; the regenerated builder adds required `event_authority` and `self_program` accounts.

### Fixed

- Event accounts (`eventAuthority`, `selfProgram`) are resolved from the active program address (SDK overlay + regenerated builders), so subscribe / cancel / resume and the transfer builders work against custom or cloned deployments without manual account overrides.

_Releases before `0.4.0` predate this changelog; see the `ts-client-v*` tags and GitHub Releases._

[#160]: https://github.com/solana-foundation/subscriptions/pull/160
[#162]: https://github.com/solana-foundation/subscriptions/pull/162
[#163]: https://github.com/solana-foundation/subscriptions/pull/163
[#164]: https://github.com/solana-foundation/subscriptions/pull/164
[#204]: https://github.com/solana-foundation/subscriptions/pull/204
[#206]: https://github.com/solana-foundation/subscriptions/pull/206
[#214]: https://github.com/solana-foundation/subscriptions/pull/214
[#221]: https://github.com/solana-foundation/subscriptions/pull/221
[#222]: https://github.com/solana-foundation/subscriptions/pull/222
