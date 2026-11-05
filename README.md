# Subscriptions

Solana program and clients for managed token delegations on SPL Token and Token-2022.

## Overview

For each `(user, mint)` pair, the program creates a **Subscription Authority (SA)** PDA and sets it as the single delegate on the user's token account with `u64::MAX` approval. The SA can only transfer tokens when a Delegation PDA authorizes it, making the system as secure as traditional approval-based delegations while enabling multiple simultaneous delegations from a single token account.

This works for both token programs: SPL Token and Token-2022.

Supported delegation models:

- **Fixed delegation**: authorize a delegatee to spend up to a total amount with an optional expiry timestamp.
- **Recurring delegation**: authorize a delegatee to spend up to a per-period amount that resets each period, with configurable period length and overall expiry.
- **Subscription plan**: a merchant publishes a plan with pricing terms; subscribers accept those terms and the merchant (or whitelisted pullers) can pull funds each billing period.

Rent stays recoverable once a delegation or subscription becomes terminal — the user closes or rotates (`init_id`) their Subscription Authority, or the plan ends: the recorded payer can then reclaim rent from the stranded PDAs via the generated `RevokeAbandonedDelegation` / `RevokeAbandonedSubscription` instructions. Revoking only the ATA delegate does not make a subscription terminal — see [Security Considerations](#security-considerations).

The program emits on-chain events via self-CPI for indexer integration (subscription created/cancelled/resumed, plan updated, and fixed/recurring/subscription transfers). The events are registered in the Codama IDL, so indexers can decode them.

Token-2022 mints are supported, including mints with a configured `TransferHook`. On delegated transfers the program forwards the caller-supplied hook accounts into the Token-2022 `TransferChecked` CPI, which resolves and runs the hook exactly as it would for a direct transfer; the program does not add or require extra hook-account guards of its own.

Destination accounts with the `MemoTransfer` extension (require-incoming-memo) are not supported: the program does not emit a Memo CPI before the transfer, so Token-2022 rejects the transfer atomically (no funds move). Use a destination without the incoming-memo requirement.

Delegation accounts include a version field and a versioning scaffold (lazy in-place update plus revoke/recreate) with a planned explicit-migrate path for future upgrades. No live migration step is wired yet (`CURRENT_VERSION == 1`). See [ADR-003](docs/003-versioning-migration-architecture.md) for details.

This repository contains:

- A Rust Solana program built with [Pinocchio](https://github.com/anza-xyz/pinocchio)
- IDL generation via [Codama](https://github.com/codama-idl/codama)
- Generated clients via Codama:
    - TypeScript client (`@solana/subscriptions`) in `clients/typescript`
    - Rust client (`subscriptions`) in `clients/rust`
- A local demo webapp in `webapp/`
- CI pipeline with build, test, lint, and CU benchmarking

## Rent Costs

Rent is recoverable: closing a delegation, plan, or subscription authority returns its rent to the original payer.

| Flow                        | Account(s) created     | Rent for new account(s) (SOL) |
| --------------------------- | ---------------------- | ----------------------------- |
| Enable authority for a mint | SubscriptionAuthority  | 0.00162864                    |
| Merchant creates a plan     | Plan                   | 0.00430824                    |
| Subscribe to a plan         | SubscriptionDelegation | 0.00196968                    |
| Grant fixed delegation      | FixedDelegation        | 0.00219240                    |
| Grant recurring delegation  | RecurringDelegation    | 0.00235944                    |

> Subscribe and delegation flows require an existing `SubscriptionAuthority`. If starting from scratch, add **0.00162864 SOL** for the "Enable authority" step.

## Program ID

```
De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44
```

## Project Structure

```text
subscriptions/
├── program/                       # Rust Solana program
│   ├── src/
│   │   ├── instructions/          # Instruction handlers
│   │   │   └── helpers/           # Transfer validation, token helpers, traits
│   │   ├── state/                 # Account types (SA, fixed, recurring, plan, subscription)
│   │   │   └── versioning/        # Version checks and migration logic
│   │   ├── events/                # On-chain event definitions
│   │   ├── event_engine.rs        # Self-CPI event emission
│   │   ├── errors.rs              # Error codes
│   │   ├── constants.rs           # Program constants
│   │   └── tests/                 # Rust unit tests
├── idl/                           # Generated IDL (subscriptions.json)
├── clients/
│   ├── typescript/                # TypeScript SDK + integration tests
│   └── rust/                      # Rust generated client
├── tests/                         # LiteSVM integration tests + transfer-hook example program
├── webapp/                        # Demo UI (React) + local API server
│   ├── src/                       # React app (routes, components, hooks)
│   ├── api/                       # Node.js API server (faucet, deploy, config)
│   └── scripts/                   # Environment init, mock test-token minting
├── scripts/                       # Shell scripts (validator, webapp launcher)
├── docs/                          # Architecture Decision Records
├── runbooks/                      # Surfpool deployment runbooks
├── .github/                       # CI workflows and shared setup action
├── .githooks/                     # Git hooks (pre-push: fmt + lint checks)
├── keys/                          # Program keypair (gitignored)
├── justfile                       # Build/test/dev task runner
├── scripts/generate-clients.ts    # Codama client generation script
└── txtx.yml                       # Surfpool runbook config
```

## Quick Start

```bash
git clone git@github.com:solana-foundation/subscriptions.git
cd subscriptions
just setup
just build
just test-program
```

For the full suite (program + client tests):

```bash
just test
```

## Prerequisites

`just setup` checks for these tools: `pnpm`, `cargo`, `solana-keygen`, and `surfpool`.

Install the toolchain:

1. Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

2. Solana CLI (includes `solana-keygen`)

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
```

3. pnpm

```bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

4. Just

```bash
curl --proto '=https' --tlsv1.2 -sSf https://just.systems/install.sh | bash -s -- --to ~/.local/bin
```

5. Surfpool CLI

```bash
curl -sL https://run.surfpool.run/ | bash
```

6. Node.js (required by `webapp/` scripts)

## Program ID Declaration

The program ID is declared in `program/src/lib.rs`. Local Surfpool workflows install the program at that canonical address via `runbooks/surfnet-setup`, so a checked-in program keypair is not required for local tests.

Print the program ID at any time:

```bash
just program-id
```

## Build and Test

The `justfile` is the main entrypoint for day-to-day development.

### Build

| Recipe                  | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `just build`            | Build program + generate IDL + generate clients + build TypeScript client |
| `just build-program`    | Compile the SBF program (`.so`)                                           |
| `just generate-idl`     | Regenerate `idl/subscriptions.json`                                       |
| `just generate-clients` | Regenerate TypeScript and Rust clients from IDL via Codama                |
| `just build-client`     | Build `clients/typescript` into `clients/typescript/dist`                 |

### Test

| Recipe                    | Description                                                   |
| ------------------------- | ------------------------------------------------------------- |
| `just test`               | Run program tests + client integration tests                  |
| `just test-program`       | Backwards-compatible alias for `just unit-test`               |
| `just unit-test`          | Run Rust unit tests                                           |
| `just integration-test`   | Run Rust LiteSVM integration tests                            |
| `just test-client`        | Run TypeScript integration tests (vitest with Surfpool)       |
| `just test-and-benchmark` | Run tests and generate `cu_report.md` with compute unit usage |

### Code Quality

| Recipe            | Description                                 |
| ----------------- | ------------------------------------------- |
| `just check`      | Run `fmt-check` + `lint-check`              |
| `just fmt-check`  | Check Rust and TypeScript formatting        |
| `just fmt`        | Auto-format Rust and TypeScript             |
| `just lint-check` | Check Rust (clippy) and TypeScript (ESLint) |
| `just lint`       | Lint with auto-fix                          |

### Cleanup

| Recipe                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| `just clean`          | Remove all build artifacts, node_modules, validator state      |
| `just webapp-clean`   | Stop webapp processes, remove webapp-specific generated state  |
| `just kill-validator` | Stop all running validators (surfpool + solana-test-validator) |

### Validator Modes

Two local validator flows are available:

- **`just test-client`** starts fresh [Surfpool](https://www.surfpool.run/) validators (a mainnet-fork pass, then an offline pass). The program is deployed from `target/deploy/` using Surfpool's built-in deployment.
- **`just webapp-run`** starts `solana-test-validator` via `scripts/start-webapp.sh`, then deploys the program and initializes the test environment.

Both default to `http://localhost:8899`.

## TypeScript Client SDK

The `@solana/subscriptions` package in `clients/typescript` is a [`@solana/kit`](https://github.com/anza-xyz/kit) plugin (`subscriptionsProgram()`) plus hand-written overlay instruction builders that wrap the Codama-generated client (PDA/ATA derivation, sponsor `payer` trailing accounts, event-account resolution).

**Overlay instruction builders** (`get*OverlayInstruction[Async]`):

| Builder                                                                                                                                                                                                                                        | Purpose                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `getInitSubscriptionAuthorityOverlayInstructionAsync` / `getCloseSubscriptionAuthorityOverlayInstructionAsync`                                                                                                                                 | Create or close the SA for a (user, mint) pair                              |
| `getCreateFixedDelegationOverlayInstructionAsync` / `getTransferFixedOverlayInstructionAsync`                                                                                                                                                  | Create a fixed delegation and pull against it                               |
| `getCreateRecurringDelegationOverlayInstructionAsync` / `getTransferRecurringOverlayInstructionAsync`                                                                                                                                          | Create a recurring delegation and pull against it                           |
| `getCreatePlanOverlayInstructionAsync` / `getUpdatePlanOverlayInstruction` / `getDeletePlanOverlayInstruction`                                                                                                                                 | Manage merchant subscription plans                                          |
| `getSubscribeOverlayInstructionAsync` / `getCancelSubscriptionOverlayInstructionAsync` / `getCancelSubscriptionNowOverlayInstructionAsync` / `getResumeSubscriptionOverlayInstructionAsync` / `getTransferSubscriptionOverlayInstructionAsync` | Subscribe, cancel immediately or at period end, resume, and pull payments   |
| `getRevokeDelegationOverlayInstruction` / `getRevokeSubscriptionOverlayInstruction`                                                                                                                                                            | Close a fixed/recurring delegation, or a subscription PDA, and reclaim rent |
| `getRevokeSubscriptionAuthorityOverlayInstructionAsync`                                                                                                                                                                                        | Revoke the program's SPL delegate and close the SA PDA                      |

**Account fetchers**: `fetchDelegationsByDelegatee`, `fetchDelegationsByDelegator`, `fetchPlansForOwner`, `fetchSubscriptionsForUser`. The plugin's `queries` namespace includes `isSubscriptionAuthorityInitialized`.

PDA derivation helpers are Codama-generated `async` functions re-exported from the package root: `findSubscriptionAuthorityPda`, `findFixedDelegationPda`, `findRecurringDelegationPda`, `findPlanPda`, `findSubscriptionDelegationPda`, `findEventAuthorityPda`.

Install and use:

```bash
pnpm add @solana/subscriptions
```

```typescript
import { subscriptionsProgram } from '@solana/subscriptions';
```

Rust client:

```bash
cargo add subscriptions
```

```rust
use subscriptions::instructions::*;
```

## Webapp Demo

The demo app in `webapp/` provides a local UI and API for development flows.

**Tech stack**: React 19, Vite, Tailwind CSS, Radix UI, TanStack Query, Jotai, Solana Kit, ConnectorKit.

```bash
just build          # build program + clients
just webapp-run     # start validator + init + API + web UI
```

Expected local endpoints:

- Validator RPC: `http://localhost:8899`
- API server: `http://localhost:3001`
- Web UI: `http://localhost:5173`

### Features

| Route            | Feature                                                   |
| ---------------- | --------------------------------------------------------- |
| `/setup`         | Setup wizard (validator, program deploy, mock test token) |
| `/`              | Dashboard overview                                        |
| `/delegations`   | Create and manage fixed/recurring delegations             |
| `/plans`         | Create and manage merchant subscription plans             |
| `/plans/collect` | Collect subscription payments                             |
| `/subscriptions` | View and manage active subscriptions                      |
| `/marketplace`   | Browse available plans                                    |
| `/faucet`        | SOL and test-token airdrops (localnet/devnet)             |
| `/program`       | Program deploy/upgrade status                             |

Stop local processes:

```bash
just kill-validator
just webapp-clean     # also removes generated state
```

## Security Audit

`subscriptions` has been audited multiple times by [Cantina](https://cantina.xyz). The latest audit is the [Subscriptions security review](audits/report-cli-cantina-a1f6fc40-7817-446d-bb88-abd0f2b96106-2026-07-30-solana-foundation-subscriptions.pdf), with external audit baseline commit `d6b3a5dc7ab18c4168441af733c81ab0a599d414` and audit fixes implemented and verified through commit `debb4f75ff7571218b39de3b633074dd843e70db`.

The full audit history, audited-through commits, and the current unaudited delta are tracked in [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md).

## Security Considerations

### Authority lifecycle and revocation

- **`init_id` is slot-granular.** Each `SubscriptionAuthority` stores an `init_id` (its creation slot) that every delegation copies; a pull works only while they match. Close+reinit invalidates old delegations only if the reinit lands in a _later_ slot — same-slot rotation reuses `init_id` and keeps them valid, and idempotent reinit never refreshes it. So rotation is not reliable revocation: use `revokeDelegation`/`cancelSubscription` for a specific permission, or `revokeSubscriptionAuthority` to revoke the approval and close the authority. Neither is durable against an unexecuted signed transaction (see below).

### Signed transactions have no freshness deadline

- **A signature binds terms, not a submission deadline.** Recent-blockhash txs expire in ~150 slots, but a durable-nonce tx or a pending multisig/smart-wallet proposal stays valid until the nonce advances or the proposal is cancelled — so a signed action can execute long after the user's intent moved on. Each control action is bound to the state the signer observed, which rejects cross-generation replays; the residual cases below share this one root.
- **The sentinel `init_id` is slot-scoped.** `UNKNOWN_INIT_ID` lets `subscribe`/`create_*_delegation` accept an authority whose `init_id` equals the current slot, so `init_subscription_authority` can be bundled in the same tx without knowing `Clock::slot` at signing. It binds to the landing slot, not the signing time — a held sentinel create binds to whatever slot it lands in. Pass the real `init_id` when known to pin the create to one authority generation.
- **A held init+subscribe bundle survives `revokeSubscriptionAuthority`.** The bundle carries its own init, so on landing — any slot, after any revoke — it re-creates the authority (`u64::MAX` re-approved) and the sentinel binds, restoring a spendable permission with no new signature. `revokeDelegation`/`cancelSubscription` only help after the permission exists; the only reliable defense is to keep the held tx from landing (submit it, or advance the nonce / cancel the proposal).
- **Authority-control actions aren't bound to a generation.** A held `init_subscription_authority` re-approves `u64::MAX` after the user manually revoked the SPL delegate, restoring collectibility of the existing delegations. A held `close`/`revoke_subscription_authority` for one authority generation, landing after the user re-creates the authority at the same PDA, destroys the new generation (revoke also drops the delegate). Generations are told apart only by `init_id`, i.e. only across slots. Same defense: don't leave authority-control txs unsubmitted.
- **`cancel_subscription_now` approvals are second-granular.** Bound to `current_period_start_ts`, so a withheld dual-signed cancel replays only if close+resubscribe lands in the same unix second as the observed period start — and then it cancels a subscription that consumed no service.
- **`resume_subscription` can't distinguish same-period cancellations.** Resume binds to the observed `expires_at_ts`, but two cancellations within one billing period compute the identical value — so a resume held across a cancel→resume→cancel cycle inside a single period can clear the second cancellation (cross-period cancellations differ and are rejected). Impact is bounded to one billing period of continued collection; the defense is the general one above — don't leave a signed resume unsubmitted.
- **`update_plan` binds to observed values, not a revision (ABA).** The approval carries the Plan state the owner saw and is rejected on any mismatch, so removing a puller invalidates a stale approval that still lists it. But it compares values, not an update count: if later updates change a field and then restore the observed value, the stale approval matches again — e.g. one expecting an empty puller set can re-add puller A once the live set returns to empty. (`expected_created_at` still blocks cross-lifecycle replay.)
- **A near-expiry subscribe is charged a full period for a partial first window.** On a finite plan the full `amount` is due even when less than one period remains before `end_ts` (zero duration if subscribing exactly at `end_ts`). Intentional — the subscriber sees `end_ts`, `amount`, and `period` when signing; `end_ts` isn't bound in the approval, but it can only be shortened (which only reduces charges), so the sole non-consensual case is a held subscribe landing in that window.

### Collectability and sponsored rent

- **On-chain "Active" is not proof of collectability.** A subscriber can revoke the SPL approval or freeze/empty/close their token account — pulls then fail while the subscription still reads active (`expires_at_ts == 0`); there is no delinquency state, so confirm collectability off-chain before granting service. Revoking the ATA delegate also leaves the subscription non-terminal, so a sponsor cannot reclaim its rent while the authority stays open; on a perpetual (`end_ts == 0`) plan the rent is locked until the subscriber cancels or closes the authority. Prefer a finite `end_ts` when sponsoring.

## Acknowledgments

Thanks to [Moonsong Labs](https://moonsonglabs.com) for the initial design and implementation of this program.

## CI Pipeline

GitHub Actions runs split workflows on PRs and pushes to `main`:

| Workflow      | Description                                          |
| ------------- | ---------------------------------------------------- |
| **Build**     | Build program and clients                            |
| **Test**      | Run Rust unit, Rust integration, and TS client tests |
| **Format**    | Check Rust and TypeScript formatting                 |
| **Lint**      | Check Rust clippy and TypeScript ESLint              |
| **Benchmark** | Generate CU report and post it as a PR comment       |
| **IDL Check** | Verify committed IDL and generated clients are fresh |

## Architecture Docs

| Document                                                 | Description                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [ADR-001](docs/001-program-architecture.md)              | Core program architecture: SA, fixed/recurring delegations, PDA design            |
| [ADR-002](docs/002-subscriptions-architecture.md)        | Subscription plans: merchant plans, subscriber flow, pull payments                |
| [ADR-003](docs/003-versioning-migration-architecture.md) | Versioning and migration: three-tier fallback chain for on-chain account upgrades |
| [ADR-004](docs/004-program-upgrade-mechanism.md)         | Program upgrades: Squads-governed upgrade authority and deployment flow           |

## Smart Wallet Support

The TypeScript client integration tests cover smart wallet flows with [Squads](https://squads.so/) (multisig) and [Swig](https://onswig.com/) wallets, verifying that delegations work when the delegator or delegatee is a program-controlled authority.

Native **`Multisig`** account owners (the SPL Token / Token-2022 built-in multisig account type) are not supported — init/revoke require the owner to sign and don't forward multisig member signers to the `Approve`/`Revoke` CPI. Use a smart-wallet program (Squads, Swig) for multi-signer treasuries.
