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

Token-2022 mints are supported, but the following extensions are rejected during SA initialization: ConfidentialTransfer, NonTransferable, PermanentDelegate, TransferHook, TransferFee, MintCloseAuthority, and Pausable.

Delegation accounts include a version field and the program implements a three-tier migration framework (lazy in-place update, explicit migrate instruction, revoke/recreate) for future upgrades. See [ADR-003](docs/003-versioning-migration-architecture.md) for details.

This repository contains:

- A Rust Solana program built with [Pinocchio](https://github.com/febo/pinocchio)
- IDL generation via [Codama](https://github.com/codama-idl/codama)
- Generated clients via Codama:
  - TypeScript client (`@subscriptions/client`) in `clients/typescript`
  - Rust client (`subscriptions-client`) in `clients/rust`
- A local demo webapp in `webapp/`
- CI pipeline with build, test, lint, and CU benchmarking

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
├── patches/                       # pnpm patch overrides
├── keys/                          # Program keypair (gitignored)
├── justfile                       # Build/test/dev task runner
├── codama.js                      # Codama client generation config
├── codama-visitors.mjs            # Codama visitors (event authority PDA, defaults)
└── txtx.yml                       # Surfpool runbook config
```

## Quick Start

```bash
git clone git@github.com:solana-program/subscriptions.git
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

## Keypair and Program ID

Local workflows use `keys/subscriptions-keypair.json` as the source keypair. The `just build` and `just build-program` recipes copy it to `target/deploy/` and verify that the keypair matches the `declare_id!` in `lib.rs`.

The keypair is checked into the repository. If it is missing, `prepare-deploy-keys` will error and prompt you to restore it:

```bash
git show <commit>^:keys/subscriptions-keypair.json > keys/subscriptions-keypair.json
```

Print the program ID at any time:

```bash
just program-id
```

## Build and Test

The `justfile` is the main entrypoint for day-to-day development.

### Build

| Recipe | Description |
|---|---|
| `just build` | Build program + generate IDL + generate clients + build TypeScript client |
| `just build-program` | Compile the SBF program (`.so`) |
| `just generate-idl` | Regenerate `idl/subscriptions.json` |
| `just generate-clients` | Regenerate TypeScript and Rust clients from IDL via Codama |
| `just build-client` | Build `clients/typescript` into `clients/typescript/dist` |

### Test

| Recipe | Description |
|---|---|
| `just test` | Run program tests + client integration tests |
| `just test-program` | Run Rust SBF tests (`cargo test-sbf` with LiteSVM) |
| `just test-client` | Run TypeScript integration tests (vitest with Surfpool) |
| `just test-and-benchmark` | Run tests and generate `cu_report.md` with compute unit usage |

### Code Quality

| Recipe | Description |
|---|---|
| `just check` | Run `fmt-check` + `lint-check` |
| `just fmt-check` | Check Rust and TypeScript formatting |
| `just fmt` | Auto-format Rust and TypeScript |
| `just lint-check` | Check Rust (clippy) and TypeScript (biome) linting |
| `just lint` | Lint with auto-fix |

### Cleanup

| Recipe | Description |
|---|---|
| `just clean` | Remove all build artifacts, node_modules, validator state |
| `just webapp-clean` | Stop webapp processes, remove webapp-specific generated state |
| `just kill-validator` | Stop all running validators (surfpool + solana-test-validator) |

### Validator Modes

Two local validator flows are available:

- **`just test-client`** starts a [Surfpool](https://www.surfpool.run/) validator automatically via `ensure-surfpool`. The program is deployed from `target/deploy/` using Surfpool's built-in deployment.
- **`just webapp-run`** starts `solana-test-validator` via `scripts/start-webapp.sh`, then deploys the program and initializes the test environment.

Both default to `http://localhost:8899`.

## TypeScript Client SDK

The `@subscriptions/client` package in `clients/typescript` provides a high-level `SubscriptionsClient` class wrapping all program instructions:

| Method | Purpose |
|---|---|
| `initSubscriptionAuthority` / `closeSubscriptionAuthority` | Create or close the SA for a (user, mint) pair |
| `createFixedDelegation` / `transferFixed` | Create a fixed delegation and execute transfers against it |
| `createRecurringDelegation` / `transferRecurring` | Create a recurring delegation and execute transfers against it |
| `createPlan` / `updatePlan` / `deletePlan` | Manage merchant subscription plans |
| `subscribe` / `cancelSubscription` / `transferSubscription` | Subscribe to plans, cancel, and pull payments |
| `revokeDelegation` | Close any delegation PDA and return rent to the original payer |
| `getDelegationsForWallet` / `getPlansForOwner` | Query on-chain accounts |
| `isSubscriptionAuthorityInitialized` | Check if an SA exists for a wallet/mint pair |

PDA derivation helpers are exported from `pdas.ts`: `getSubscriptionAuthorityPDA`, `getDelegationPDA`, `getPlanPDA`, `getSubscriptionPDA`, `getEventAuthorityPDA`.

Install and use:

```bash
pnpm add @subscriptions/client
```

```typescript
import { SubscriptionsClient } from '@subscriptions/client';
```

## Webapp Demo

The demo app in `webapp/` provides a local UI and API for development flows.

**Tech stack**: React 19, Vite, Tailwind CSS, Radix UI, TanStack Query, Jotai, Solana Kit, Wallet UI.

```bash
just build          # build program + clients
just webapp-run     # start validator + init + API + web UI
```

Expected local endpoints:

- Validator RPC: `http://localhost:8899`
- API server: `http://localhost:3001`
- Web UI: `http://localhost:5173`

### Features

| Route | Feature |
|---|---|
| `/setup` | Setup wizard (validator, program deploy, mock USDC) |
| `/` | Dashboard overview |
| `/delegations` | Create and manage fixed/recurring delegations |
| `/plans` | Create and manage merchant subscription plans |
| `/plans/collect` | Collect subscription payments |
| `/subscriptions` | View and manage active subscriptions |
| `/marketplace` | Browse available plans |
| `/faucet` | SOL and USDC airdrops (localnet/devnet) |
| `/program` | Program deploy/upgrade status |

Stop local processes:

```bash
just kill-validator
just webapp-clean     # also removes generated state
```

## Security Audit

`subscriptions` has been audited by [Cantina](https://cantina.xyz). View the [audit report](audits/report-cli-cantina-db2ffeea-c85c-4f35-b188-e861cdcd785d-solana-subscriptions.pdf).

The external audit baseline is commit `18a50bc21c4b91ed62e612109c371f41200385e8`, and audit fixes were implemented and verified through commit `b4b0345f9fd616e1355b7b6628362283fd6b1691`.

Audit status, audited-through commit, and the current unaudited delta are tracked in [audits/AUDIT_STATUS.md](audits/AUDIT_STATUS.md).

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on PRs and pushes to `main`:

| Job | Description |
|---|---|
| **build** | Build program + client, upload artifacts |
| **unit-test** | `just test-program` (Rust SBF tests) |
| **lint** | `just check` (formatting + clippy + biome) |
| **integration-test** | Start Surfpool, run TypeScript integration tests |
| **benchmark** | (PRs only) Generate CU report and post as PR comment |

## Architecture Docs

| Document | Description |
|---|---|
| [ADR-001](docs/001-program-architecture.md) | Core program architecture: SA, fixed/recurring delegations, PDA design |
| [ADR-002](docs/002-subscriptions-architecture.md) | Subscription plans: merchant plans, subscriber flow, pull payments |
| [ADR-003](docs/003-versioning-migration-architecture.md) | Versioning and migration: three-tier fallback chain for on-chain account upgrades |

## Smart Wallet Support

The TypeScript client integration tests cover smart wallet flows with [Squads](https://squads.so/) (multisig) and [Swig](https://swig.so/) wallets, verifying that delegations work when the delegator or delegatee is a program-controlled authority.
