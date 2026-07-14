# Subscriptions

Solana program and clients for managed token delegations on SPL Token and Token-2022.

## Overview

For each `(user, mint)` pair, the program creates a **Subscription Authority (SA)** PDA and sets it as the single delegate on the user's token account with `u64::MAX` approval. The SA can only transfer tokens when a Delegation PDA authorizes it, making the system as secure as traditional approval-based delegations while enabling multiple simultaneous delegations from a single token account.

This works for both token programs: SPL Token and Token-2022.

Supported delegation models:

- **Fixed delegation**: authorize a delegatee to spend up to a total amount with an optional expiry timestamp.
- **Recurring delegation**: authorize a delegatee to spend up to a per-period amount that resets each period, with configurable period length and overall expiry.
- **Subscription plan**: a merchant publishes a plan with pricing terms; subscribers accept those terms and the merchant (or whitelisted pullers) can pull funds each billing period.

Rent stays recoverable even after a user closes or re-initializes their Subscription Authority: the recorded payer can reclaim rent from the stranded delegation or subscription PDAs via the generated `RevokeAbandonedDelegation` / `RevokeAbandonedSubscription` instructions.

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

| Builder                                                                                                                                                                                    | Purpose                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `getInitSubscriptionAuthorityOverlayInstructionAsync` / `getCloseSubscriptionAuthorityOverlayInstructionAsync`                                                                             | Create or close the SA for a (user, mint) pair                              |
| `getCreateFixedDelegationOverlayInstructionAsync` / `getTransferFixedOverlayInstructionAsync`                                                                                              | Create a fixed delegation and pull against it                               |
| `getCreateRecurringDelegationOverlayInstructionAsync` / `getTransferRecurringOverlayInstructionAsync`                                                                                      | Create a recurring delegation and pull against it                           |
| `getCreatePlanOverlayInstructionAsync` / `getUpdatePlanOverlayInstruction` / `getDeletePlanOverlayInstruction`                                                                             | Manage merchant subscription plans                                          |
| `getSubscribeOverlayInstructionAsync` / `getCancelSubscriptionOverlayInstructionAsync` / `getResumeSubscriptionOverlayInstructionAsync` / `getTransferSubscriptionOverlayInstructionAsync` | Subscribe, cancel/resume, and pull payments                                 |
| `getRevokeDelegationOverlayInstruction` / `getRevokeSubscriptionOverlayInstruction`                                                                                                        | Close a fixed/recurring delegation, or a subscription PDA, and reclaim rent |
| `getRevokeSubscriptionAuthorityOverlayInstructionAsync`                                                                                                                                    | Revoke the program's SPL delegate and close the SA PDA                      |

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

`subscriptions` has been audited multiple times by [Cantina](https://cantina.xyz). The latest audit is the [Subscriptions security review](audits/report-cli-cantina-0c329845-47bc-4915-a50d-56dbc442b76a-solana-subscriptions.pdf), with external audit baseline commit `38b88bebd2c3f13ba2fbd54795e9ecc8619f8c0c` and audit fixes implemented and verified through commit `2d7b45bdc998dc582874fc8ab32ac03f9c786c1e`.

The full audit history, audited-through commits, and the current unaudited delta are tracked in [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md).

## Security Considerations

- **`init_id` is slot-granular.** Closing and re-initializing a SubscriptionAuthority invalidates existing delegations only when the re-init lands in a later slot than the original init. If the whole create→close→reinit sequence runs in one slot (a single transaction, co-slot transactions, or an atomic bundle), the reused `init_id` keeps old delegations valid. Authority rotation is therefore not a reliable revocation mechanism — use `revokeDelegation` to stop a specific delegation.
- **Signed creation transactions have no on-chain freshness deadline.** Creation instructions bind the user to terms but not to a latest-submission time. Recent-blockhash transactions expire in ~150 slots (~60-90s), but a durable-nonce transaction stays valid until the nonce advances and can create state long after signing.
- **On-chain "Active" is not proof of collectability.** A subscriber can revoke the SPL approval or freeze/empty/close their source token account — future pulls then fail while the subscription still reads active (`expires_at_ts == 0`); there is no on-chain delinquency state. Confirm collectability off-chain before granting service.

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

The TypeScript client integration tests cover smart wallet flows with [Squads](https://squads.so/) (multisig) and [Swig](https://swig.so/) wallets, verifying that delegations work when the delegator or delegatee is a program-controlled authority.

Native **`Multisig`** account owners (the SPL Token / Token-2022 built-in multisig account type) are not supported — init/revoke require the owner to sign and don't forward multisig member signers to the `Approve`/`Revoke` CPI. Use a smart-wallet program (Squads, Swig) for multi-signer treasuries.
