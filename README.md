# Subscriptions

Solana program and clients for managed token delegations on SPL Token and Token-2022.

## Overview

For each `(user, mint)` pair, the program creates a **Subscription Authority (SA)** PDA and sets it as the single delegate on the user's token account with `u64::MAX` approval. The SA can only transfer tokens when a Delegation PDA authorizes it, making the system as secure as traditional approval-based delegations while enabling multiple simultaneous delegations from a single token account.

This works for both token programs: SPL Token and Token-2022.

Supported delegation models:

- **Fixed delegation**: authorize a delegatee to spend up to a total amount with an optional expiry timestamp.
- **Recurring delegation**: authorize a delegatee to spend up to a per-period amount that resets each period, with configurable period length and overall expiry.
- **Subscription plan**: a merchant publishes a plan with pricing terms; subscribers accept those terms and the merchant (or whitelisted pullers) can pull funds each billing period.

The program emits on-chain events via self-CPI for indexer integration (subscription created/cancelled, fixed/recurring/subscription transfers).

Token-2022 mints are supported, including mints with a configured `TransferHook`. On delegated transfers the program forwards the mint's runtime hook accounts into the Token-2022 `TransferChecked` CPI, which executes the configured hook program. The hook's `ExtraAccountMetaList` validation PDA is required among those accounts, so an active hook's configured policy context is always enforced.

Delegation accounts include a version field and the program implements a three-tier migration framework (lazy in-place update, explicit migrate instruction, revoke/recreate) for future upgrades. See [ADR-003](docs/003-versioning-migration-architecture.md) for details.

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
│   │   └── tests/                 # Rust unit tests (LiteSVM)
├── idl/                           # Generated IDL (subscriptions.json)
├── clients/
│   ├── typescript/                # TypeScript SDK + integration tests
│   └── rust/                      # Rust generated client
├── webapp/                        # Demo UI (React) + local API server
│   ├── src/                       # React app (routes, components, hooks)
│   ├── api/                       # Node.js API server (faucet, deploy, config)
│   └── scripts/                   # Environment init, mock USDC minting
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

## Program ID

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

- **`just test-client`** starts a [Surfpool](https://www.surfpool.run/) validator automatically via `ensure-surfpool`. The program is deployed from `target/deploy/` using Surfpool's built-in deployment.
- **`just webapp-run`** starts `solana-test-validator` via `scripts/start-webapp.sh`, then deploys the program and initializes the test environment.

Both default to `http://localhost:8899`.

## TypeScript Client SDK

The `@solana/subscriptions` package in `clients/typescript` provides a high-level `SubscriptionsClient` class wrapping all program instructions:

| Method                                                                             | Purpose                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `initSubscriptionAuthority` / `closeSubscriptionAuthority`                         | Create or close the SA for a (user, mint) pair                 |
| `createFixedDelegation` / `transferFixed`                                          | Create a fixed delegation and execute transfers against it     |
| `createRecurringDelegation` / `transferRecurring`                                  | Create a recurring delegation and execute transfers against it |
| `createPlan` / `updatePlan` / `deletePlan`                                         | Manage merchant subscription plans                             |
| `subscribe` / `cancelSubscription` / `resumeSubscription` / `transferSubscription` | Subscribe to plans, cancel or resume, and pull payments        |
| `revokeDelegation`                                                                 | Close any delegation PDA and return rent to the original payer |
| `getDelegationsForWallet` / `getPlansForOwner`                                     | Query on-chain accounts                                        |
| `isSubscriptionAuthorityInitialized`                                               | Check if an SA exists for a wallet/mint pair                   |

PDA derivation helpers are exported from `pdas.ts`: `getSubscriptionAuthorityPDA`, `getDelegationPDA`, `getPlanPDA`, `getSubscriptionPDA`, `getEventAuthorityPDA`.

Install and use:

```bash
pnpm add @solana/subscriptions
```

```typescript
import { SubscriptionsClient } from '@solana/subscriptions';
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

| Route            | Feature                                             |
| ---------------- | --------------------------------------------------- |
| `/setup`         | Setup wizard (validator, program deploy, mock USDC) |
| `/`              | Dashboard overview                                  |
| `/delegations`   | Create and manage fixed/recurring delegations       |
| `/plans`         | Create and manage merchant subscription plans       |
| `/plans/collect` | Collect subscription payments                       |
| `/subscriptions` | View and manage active subscriptions                |
| `/marketplace`   | Browse available plans                              |
| `/faucet`        | SOL and USDC airdrops (localnet/devnet)             |
| `/program`       | Program deploy/upgrade status                       |

Stop local processes:

```bash
just kill-validator
just webapp-clean     # also removes generated state
```

## Security Audit

`subscriptions` has been audited by [Cantina](https://cantina.xyz). View the [audit report](audits/report-cli-cantina-db2ffeea-c85c-4f35-b188-e861cdcd785d-solana-multi-delegator.pdf).

The external audit baseline is commit `18a50bc21c4b91ed62e612109c371f41200385e8`, and audit fixes were implemented and verified through commit `b4b0345f9fd616e1355b7b6628362283fd6b1691`.

Audit status, audited-through commit, and the current unaudited delta are tracked in [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md).

## Security Considerations

- **`init_id` is slot-granular.** Closing and re-initializing a SubscriptionAuthority invalidates existing delegations only when the re-init lands in a later slot than the original init. If the whole create→close→reinit sequence runs in one slot (a single transaction, co-slot transactions, or an atomic bundle), the reused `init_id` keeps old delegations valid. Authority rotation is therefore not a reliable revocation mechanism — use `revokeDelegation` to stop a specific delegation.
- **Signed creation transactions have no on-chain freshness deadline.** Creation instructions bind the user to terms but not to a latest-submission time. Recent-blockhash transactions expire in ~150 slots (~60-90s), but a durable-nonce transaction stays valid until the nonce advances and can create state long after signing.

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

## Smart Wallet Support

The TypeScript client integration tests cover smart wallet flows with [Squads](https://squads.so/) (multisig) and [Swig](https://swig.so/) wallets, verifying that delegations work when the delegator or delegatee is a program-controlled authority.
